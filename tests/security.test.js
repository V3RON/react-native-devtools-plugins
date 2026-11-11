// Hardening tests for the extension-frame layer (GitHub issue #6):
//
//   - per-extension CSP from the manifest, defaulting to Chrome's MV3 policy
//     (src/shared/csp.js, served by src/main/extension-server.js);
//   - declared permissions mapping and the gate's unknown-manifest behavior
//     (src/shared/permissions.js);
//   - which network deliveries a frame may receive per grant
//     (src/main/delivery-scope.js);
//   - the one webPreferences table the whole window runs on
//     (src/main/frame-security.js);
//   - that no IPC channel is synchronous any more (src/shared/ipc.js).
//
// What a frame can actually reach at runtime is asserted in a real Electron
// process: tests/extension-frame-electron.test.js.
// Run: npm test
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const {
  DEFAULT_EXTENSION_PAGES_CSP,
  contentSecurityPolicyFor,
  defaultCspFor,
  unsafeReason,
} = require("../src/shared/csp");
const {
  createGrantGate,
  createPermissionGate,
  declaredPermissions,
  requiredPermission,
} = require("../src/shared/permissions");
const { deliveryAllowed } = require("../src/main/delivery-scope");
const { frontendPreferences, extensionFramePreferences } = require("../src/main/frame-security");
const channels = require("../src/shared/ipc");

const REPO = path.join(__dirname, "..");
const readSource = (...parts) => fs.readFileSync(path.join(REPO, ...parts), "utf8");

// Code, without comments: this file asserts on source shape, and the sources
// document what they no longer contain ("no sendSync here") — a comment must
// not fail an assertion about the code it describes. Doc-presence assertions use
// readSource instead.
const codeOf = (source) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\*\/)/.test(line))
    .join("\n");
const readCode = (...parts) => codeOf(readSource(...parts));

// ── who the frontend is (docs/SECURITY-PLATFORM.md F4) ───────────────────────
//
// Two facts used to be one hole: the preload decided "is this the frontend?" by
// ABSENCE ("not the extension scheme" + "isMainFrame"), so any extension window that
// navigated away received the frontend's InspectorFrontendHost surface; and the nine
// channels that surface calls (PREF_*, WINDOW_*, SHOW_CONTEXT_MENU) never asked who was
// calling. Both halves are pinned here; the live halves (a real navigated-away window,
// the real registered handlers refusing it) are in tests/frontend-host-electron.test.js.
const {
  DEFAULT_FRONTEND_URL,
  isExtensionUrl,
  isFrontendUrl,
  preloadBranch,
} = require("../src/shared/frontend-identity");
const { extensionNavigationAllowed } = require("../src/main/extension-window-policy");

const FRONTEND = "http://127.0.0.1:8081/rozenite/rn_fusebox.html?ws=localhost:9223";

test("the frontend is identified by its URL, not by the absence of the extension scheme", () => {
  // Same origin, any path: the frontend's own navigations, its reloads, its subpages.
  assert.strictEqual(isFrontendUrl("http://127.0.0.1:8081/other.html", FRONTEND), true);
  assert.strictEqual(isFrontendUrl(FRONTEND, FRONTEND), true);
  // Another port, another host, another scheme: not the frontend.
  assert.strictEqual(isFrontendUrl("http://127.0.0.1:8082/x.html", FRONTEND), false);
  assert.strictEqual(isFrontendUrl("http://evil.test/rozenite/rn_fusebox.html", FRONTEND), false);
  assert.strictEqual(isFrontendUrl("https://127.0.0.1:8081/x.html", FRONTEND), false);
  // The F4 documents: an extension page, and the page such a window lands on.
  assert.strictEqual(isFrontendUrl("rozenite://graphql/panel.html", FRONTEND), false);
  assert.strictEqual(isFrontendUrl("https://evil.test/landed", FRONTEND), false);
  // Origin-less documents cannot prove they are the frontend.
  assert.strictEqual(isFrontendUrl("about:blank", FRONTEND), false);
  assert.strictEqual(isFrontendUrl("data:text/html,x", FRONTEND), false);
  // Measured, and kept deliberately: a `blob:` URL's URL.origin is the origin that CREATED
  // it (blob:http://127.0.0.1:8081/uuid -> that origin), which is the browser's own identity
  // model — a blob document is same-origin with its creator, and only frontend-origin script
  // can mint a blob: URL for the frontend's origin. src/main/frontend-frame.js already reads
  // URL.origin for the channels, so the two realms agree here by construction: the identity
  // is positive in both. A blob minted by an extension page reports the opaque origin
  // (blob:rozenite://graphql/uuid -> "null"), so it is not the frontend either way.
  assert.strictEqual(isFrontendUrl("blob:http://127.0.0.1:8081/uuid", FRONTEND), true);
  assert.strictEqual(isFrontendUrl("blob:rozenite://graphql/uuid", FRONTEND), false);
  // Nothing announced, nothing is the frontend: the check fails CLOSED.
  assert.strictEqual(isFrontendUrl("http://127.0.0.1:8081/a.html", ""), false);
  assert.strictEqual(isFrontendUrl("http://127.0.0.1:8081/a.html", "not a url"), false);
  assert.strictEqual(isFrontendUrl("", FRONTEND), false);
  assert.strictEqual(isFrontendUrl(undefined, FRONTEND), false);
  // An opaque-origin frontend identifies nothing, so it matches nothing — including itself.
  // This is src/main/frontend-frame.js's pre-existing behavior (an origin-less frontend URL
  // has always been refused rather than guessed at), and a fix that narrows nine channels is
  // not the place to widen that one as a side effect.
  assert.strictEqual(isFrontendUrl("about:blank", "about:blank"), false);
  assert.strictEqual(
    isFrontendUrl("file:///opt/frontend/frontend.html", "file:///opt/frontend/frontend.html"),
    false,
    "a file:// frontend is not an identity this shell claims — fail closed, as before"
  );
  assert.strictEqual(isFrontendUrl("file:///opt/other/x.html", "file:///opt/frontend/frontend.html"), false);
  // A file: candidate against an http frontend: no match by any rule.
  assert.strictEqual(isFrontendUrl("file:///opt/frontend/frontend.html", FRONTEND), false);
});

test("an extension URL is recognized by the scheme alone", () => {
  assert.strictEqual(isExtensionUrl("rozenite://graphql/panel.html"), true);
  assert.strictEqual(isExtensionUrl("rozenite://graphql/"), true);
  assert.strictEqual(isExtensionUrl("http://127.0.0.1:8081/x"), false);
  assert.strictEqual(isExtensionUrl("not a url"), false);
  assert.strictEqual(isExtensionUrl(undefined), false);
});

test("the preload dispatch policy names the branch by identity", () => {
  // Extension frames first, whatever else is true of them: a MAIN frame too (the hidden
  // worker window) and a main frame that is also on the frontend's origin by accident.
  assert.strictEqual(preloadBranch("rozenite://graphql/__rozenite_background__", true, FRONTEND), "extension");
  assert.strictEqual(preloadBranch("rozenite://graphql/panel.html", false, FRONTEND), "extension");
  assert.strictEqual(preloadBranch("rozenite://x/y", true, "rozenite://x/y"), "extension");
  // The frontend: main frame, frontend origin.
  assert.strictEqual(preloadBranch(FRONTEND, true, FRONTEND), "frontend");
  assert.strictEqual(preloadBranch("http://127.0.0.1:8081/other.html", true, FRONTEND), "frontend");
  // An iframe of the frontend is NOT the frontend host — main applies the same rule to the
  // channels (src/main/frontend-frame.js), so the two must not disagree here.
  assert.strictEqual(preloadBranch("http://127.0.0.1:8081/child.js", false, FRONTEND), "none");
  // The F4 cases: a navigated-away extension window, and anything else with a preload.
  assert.strictEqual(preloadBranch("https://evil.test/landed", true, FRONTEND), "none");
  assert.strictEqual(preloadBranch("about:blank", true, FRONTEND), "none");
  assert.strictEqual(preloadBranch("file:///etc/passwd", true, FRONTEND), "none");
  assert.strictEqual(preloadBranch("http://127.0.0.1:8081/x", true, ""), "none");
});

test("the renderer's frontend URL cannot drift from main's", () => {
  // src/main/config.js keeps its own copy of the default because a renderer preload cannot
  // import it (config pulls in the main process). This is what keeps the two honest.
  const config = require("../src/main/config");
  assert.strictEqual(
    config.frontendURL,
    process.env.DEVTOOLS_FRONTEND_URL || DEFAULT_FRONTEND_URL
  );
});

test("src/preload/index.js dispatches by that policy and not by absence", () => {
  const source = readCode("src", "preload", "index.js");
  assert.match(source, /preloadBranch/, "the branch comes from the shared policy");
  assert.match(source, /window\.location\.href/, "decided from this frame's own URL");
  assert.doesNotMatch(
    source,
    /else\s+if\s*\(\s*process\.isMainFrame\s*\)/,
    "the absence rule that handed navigated-away windows the frontend surface is gone"
  );
});

// ── extension-owned windows: navigation + window.open (F4 / §4 L4) ───────────
test("an extension window may navigate to its own extension and nothing else", () => {
  const own = "rozenite://graphql/__rozenite_background__?script=background.js";
  assert.strictEqual(extensionNavigationAllowed(own, own), true, "a reload is not a navigation");
  assert.strictEqual(extensionNavigationAllowed("rozenite://graphql/other.js", own), true);
  assert.strictEqual(
    extensionNavigationAllowed("rozenite://GRAPHQL/x.js", own),
    true,
    "the host comparison is case-insensitive, as URL hosts are"
  );
  // Another extension is another principal, even on the same scheme.
  assert.strictEqual(extensionNavigationAllowed("rozenite://altair/panel.html", own), false);
  // Every other scheme, including the frontend's own.
  for (const url of [
    "https://evil.test/x",
    "http://127.0.0.1:8081/rozenite/rn_fusebox.html",
    "file:///etc/passwd",
    "about:blank",
    "data:text/html,<script>x</script>",
    "blob:rozenite://graphql/uuid",
    "javascript:alert(1)",
    "not a url",
    "",
    undefined,
  ]) {
    assert.strictEqual(extensionNavigationAllowed(url, own), false, String(url));
  }
  // An unparseable own URL guards nothing, so it lets nothing through.
  assert.strictEqual(extensionNavigationAllowed("rozenite://graphql/x.js", "nonsense"), false);
});

test("the extension-window guard installs both hooks and denies what the policy refuses", () => {
  const { guardExtensionWindow } = require("../src/main/extension-window-policy");
  const handlers = {};
  let openPolicy = null;
  const contents = {
    on: (event, fn) => {
      handlers[event] = fn;
    },
    setWindowOpenHandler: (fn) => {
      openPolicy = fn;
    },
  };
  const warn = [];
  guardExtensionWindow(contents, "rozenite://graphql/__rozenite_background__", "background", (m) =>
    warn.push(m)
  );
  assert.ok(handlers["will-navigate"], "will-navigate is guarded");
  assert.ok(handlers["will-redirect"], "will-redirect is guarded (a redirect is a navigation)");
  assert.strictEqual(typeof openPolicy, "function", "window.open has a handler");
  assert.deepStrictEqual(openPolicy({ url: "https://evil.test" }), { action: "deny" });

  const attempt = (url) => {
    let prevented = false;
    handlers["will-navigate"]({ preventDefault: () => (prevented = true) }, url);
    return prevented;
  };
  assert.strictEqual(attempt("rozenite://graphql/other.js"), false, "its own extension stays");
  assert.strictEqual(attempt("https://evil.test/landed"), true);
  assert.strictEqual(attempt("rozenite://altair/__rozenite_background__"), true);
  assert.strictEqual(attempt("about:blank"), true);
  assert.ok(warn.some((line) => line.includes("evil.test")), "a refusal says so, like the frontend's");
});

// ── the nine channels ask who is calling (F4) ────────────────────────────────
test("all nine frontend-only channels go through the frontendOnly gate", () => {
  // The set the issue names, from src/shared/ipc.js — pinned as a SET so a tenth channel
  // cannot join it silently. (tests/security.test.js's own sendSync pin is the same kind of
  // structural assertion; issue #28 replaces this with a general lint.)
  const nine = [
    "SHOW_CONTEXT_MENU",
    "PREF_REGISTER",
    "PREF_GET",
    "PREF_GET_ALL",
    "PREF_SET",
    "PREF_REMOVE",
    "PREF_CLEAR",
    "WINDOW_BRING_TO_FRONT",
    "WINDOW_CLOSE",
  ];
  assert.deepStrictEqual(nine.sort(), [
    "PREF_CLEAR",
    "PREF_GET",
    "PREF_GET_ALL",
    "PREF_REGISTER",
    "PREF_REMOVE",
    "PREF_SET",
    "SHOW_CONTEXT_MENU",
    "WINDOW_BRING_TO_FRONT",
    "WINDOW_CLOSE",
  ]);

  // Whitespace-tolerant (`\s*`), so the pin is about the composition and not about the
  // line breaks a formatter may choose.
  const source = readCode("src", "main", "ipc.js");
  for (const name of nine) {
    const registration = new RegExp(`ipcMain\\.handle\\(\\s*${name},\\s*frontendOnly\\(\\s*${name},`);
    assert.match(source, registration, `${name} is registered through frontendOnly`);
  }
  // And the gate is the same rule the file already applies to the HOST_* channels,
  // composed through a gate that takes its checks as arguments — so issue #25 can add a
  // context-role check to a channel without rewriting its gate.
  assert.match(
    source,
    /const frontendOnly = senderOnly\(\s*REFUSED,\s*isFrontendFrame\s*\)/,
    "one gate, built from the same frontend-frame rule the HOST_* channels use"
  );
  assert.match(
    source,
    /const senderOnly =\s*\(refused,\s*\.\.\.checks\)\s*=>\s*\(channel,\s*handler\)\s*=>\s*\(event,\s*\.\.\.args\)/,
    "the wrapper is variadic in its checks, which is what lets a second role gate compose with this one"
  );
});

// ── CSP ──────────────────────────────────────────────────────────────────────
test("no declared CSP gets Chrome's MV3 extension policy, not nothing", () => {
  assert.deepStrictEqual(contentSecurityPolicyFor({}), {
    value: DEFAULT_EXTENSION_PAGES_CSP,
    source: "default",
  });
  assert.deepStrictEqual(contentSecurityPolicyFor({ name: "x", manifest_version: 3 }), {
    value: "script-src 'self'; object-src 'self'",
    source: "default",
  });
  // Chrome's one relaxation: an extension with a service worker may use wasm.
  assert.match(defaultCspFor({ background: { service_worker: "bg.js" } }), /wasm-unsafe-eval/);
  assert.doesNotMatch(defaultCspFor({ background: { scripts: ["bg.js"] } }), /wasm-unsafe-eval/);
});

test("a declared extension_pages policy is the header value", () => {
  const declared = "script-src 'self' https://cdn.example; object-src 'none'";
  assert.deepStrictEqual(
    contentSecurityPolicyFor({ content_security_policy: { extension_pages: declared } }),
    { value: declared, source: "manifest" }
  );
  // MV2-style bare string is accepted too.
  assert.deepStrictEqual(contentSecurityPolicyFor({ content_security_policy: declared }), {
    value: declared,
    source: "manifest",
  });
});

test("an empty or malformed declaration falls back to the default, never to no policy", () => {
  for (const manifest of [
    { content_security_policy: "" },
    { content_security_policy: "   " },
    { content_security_policy: {} }, // Altair's real manifest declares this
    { content_security_policy: null },
    { content_security_policy: 42 },
    { content_security_policy: { sandbox_pages: "  " } },
  ]) {
    const policy = contentSecurityPolicyFor(manifest);
    assert.strictEqual(policy.value, DEFAULT_EXTENSION_PAGES_CSP, JSON.stringify(manifest));
    assert.strictEqual(policy.source, "default");
  }
});

test("unsafe declarations are recognizable as unsafe", () => {
  assert.match(unsafeReason({ value: "script-src 'unsafe-eval'; object-src 'self'" }), /eval/);
  assert.match(unsafeReason({ value: "script-src https://x.test; object-src 'self'" }), /remote/);
  assert.match(unsafeReason({ value: "script-src 'self'" }), /missing object-src/);
  assert.match(unsafeReason({ value: "object-src 'self'" }), /missing script-src/);
  assert.strictEqual(unsafeReason({ value: DEFAULT_EXTENSION_PAGES_CSP }), null);
  assert.strictEqual(
    unsafeReason({ value: "script-src 'self' wasm-unsafe-eval; object-src 'self'" }),
    null,
    "Chrome's own wasm allowance is not 'unsafe'"
  );
});

test("every bundled extension resolves to a policy Chrome would accept", () => {
  const dirs = fs
    .readdirSync(path.join(REPO, "extensions"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  assert.ok(dirs.length >= 3, "expected the bundled extensions to be present");
  for (const id of dirs) {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(REPO, "extensions", id, "manifest.json"), "utf8")
    );
    const policy = contentSecurityPolicyFor(manifest);
    assert.ok(policy.value.length > 0, `${id}: non-empty policy`);
    assert.strictEqual(
      unsafeReason(policy),
      null,
      `${id}: ${policy.value} must not be weaker than Chrome's default`
    );
  }
});

test("bundled extension pages carry no inline scripts, which the default CSP refuses", () => {
  // Chrome's MV3 default is `script-src 'self'`, and this shell serves it to every
  // extension that declares no policy — so an inline `<script>` in a bundled page
  // would not fail loudly, it would simply never run. Asserted statically (and the
  // runtime side is covered by the fixture's refused inline script in
  // tests/extension-frame-electron.test.js).
  const walk = (dir, found = []) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, found);
      else if (entry.name.endsWith(".html")) found.push(full);
    }
    return found;
  };
  const inline = /<script(?![^>]*\bsrc=)[^>]*>(?![\s<]*<\/script>)/i;
  const pages = walk(path.join(REPO, "extensions"));
  assert.ok(pages.length >= 5, `expected the bundled pages, found ${pages.length}`);
  for (const page of pages) {
    const html = fs.readFileSync(page, "utf8");
    assert.ok(
      !inline.test(html),
      `${path.relative(REPO, page)} has an inline <script>, which ` +
        `"${DEFAULT_EXTENSION_PAGES_CSP}" blocks — give it a src= file instead`
    );
  }
});

test("the file server attaches the CSP header to every response", () => {
  const source = readCode("src", "main", "extension-server.js");
  assert.match(source, /"Content-Security-Policy"/, "responses carry the header");
  assert.match(source, /contentSecurityPolicyFor/, "derived from the manifest");
  assert.match(source, /policyForManifest/, "with the unsafe-policy fallback");
});

// ── declared permissions ─────────────────────────────────────────────────────
test("only `permissions` counts as a declaration", () => {
  assert.deepStrictEqual(
    declaredPermissions({
      permissions: ["storage", "tabs", 7, undefined],
      host_permissions: ["<all_urls>"],
      optional_permissions: ["bookmarks"],
    }),
    ["storage", "tabs"]
  );
  assert.deepStrictEqual(declaredPermissions({}), []);
  assert.deepStrictEqual(declaredPermissions(undefined), []);
});

test("the permission an API needs, and the APIs that need none", () => {
  assert.strictEqual(requiredPermission("webRequest"), "webRequest");
  assert.strictEqual(requiredPermission("tabs"), "tabs");
  assert.strictEqual(requiredPermission("storage"), "storage");
  // Chrome's DevTools APIs need no manifest permission; neither do ours.
  assert.strictEqual(requiredPermission("devtools"), null);
  assert.strictEqual(requiredPermission("runtime"), null);
});

test("a declared permission allows the API and an undeclared one is refused with a message", () => {
  const gate = createPermissionGate(() => ({ permissions: ["webRequest"] }));
  assert.deepStrictEqual(gate.check("webRequest"), { ok: true });
  const denied = gate.check("tabs");
  assert.strictEqual(denied.ok, false);
  assert.strictEqual(denied.permission, "tabs");
  assert.match(denied.error, /permission 'tabs' is not declared/);
  assert.match(denied.error, /chrome\.tabs\.\*/, "names the API the extension called");
});

test("an unknown manifest yields a promise instead of a wrong denial", () => {
  let manifest = null;
  const gate = createPermissionGate(() => manifest);
  const pending = gate.check("storage");
  assert.strictEqual(typeof pending.then, "function", "unknown means 'wait', not 'deny'");
  let settled = "pending";
  pending.then((verdict) => {
    settled = verdict;
  });

  manifest = { permissions: ["storage"] };
  gate.manifestLoaded();
  return pending.then((verdict) => {
    assert.deepStrictEqual(verdict, { ok: true }, "a held permission is never denied");
    assert.deepStrictEqual(settled, { ok: true });
    // Now known: answers are synchronous again.
    assert.deepStrictEqual(gate.check("tabs").ok, false);
  });
});

test("the grant gate reads the host's verdict, not the frame's manifest", () => {
  let grants;
  const gate = createGrantGate(() => grants);
  assert.strictEqual(
    typeof gate.check("webRequest").then,
    "function",
    "unknown until the host answers"
  );
  grants = { webRequest: true, tabs: false };
  gate.manifestLoaded();
  return Promise.resolve(gate.check("webRequest")).then((verdict) => {
    assert.deepStrictEqual(verdict, { ok: true });
    assert.strictEqual(gate.check("tabs").ok, false);
    assert.strictEqual(gate.has("webRequest"), true);
    assert.strictEqual(gate.has("notifications"), false);
    // An API that needs nothing is allowed regardless of the map.
    assert.deepStrictEqual(gate.check("devtools"), { ok: true });
  });
});

// ── transport-side delivery scope ────────────────────────────────────────────
test("a frame without `webRequest` is not sent the webRequest-only lifecycle", () => {
  for (const kind of ["request", "sendHeaders", "response", "redirect"]) {
    assert.strictEqual(
      deliveryAllowed({ webRequest: false }, kind),
      false,
      `${kind} feeds only chrome.webRequest`
    );
    assert.strictEqual(deliveryAllowed({ webRequest: true }, kind), true);
    assert.strictEqual(deliveryAllowed({}, kind), false, "no grants at all means no webRequest data");
  }
});

test("devtools.network data keeps flowing to a frame without the permission", () => {
  // Chrome requires no permission for chrome.devtools.network, and its
  // onRequestFinished rides the same `completed`/`error` messages as
  // webRequest.onCompleted. Dropping those would break the API for a legitimate
  // extension — Altair declares no `webRequest` at all.
  for (const kind of ["completed", "error", "navigated", "status"]) {
    assert.strictEqual(deliveryAllowed({ webRequest: false }, kind), true, kind);
  }
  assert.strictEqual(deliveryAllowed(undefined, "completed"), true);
  assert.strictEqual(deliveryAllowed(undefined, "request"), false);
});

// ── webPreferences ───────────────────────────────────────────────────────────
test("every frame class runs with the narrowed baseline", () => {
  const prefs = frontendPreferences({ preloadPath: "/tmp/preload.js" });
  assert.deepStrictEqual(extensionFramePreferences({ preloadPath: "/tmp/preload.js" }), prefs);
  assert.equal(prefs.preload, "/tmp/preload.js");
  assert.equal(prefs.nodeIntegration, false, "no Node surface in any page world");
  assert.equal(prefs.contextIsolation, true);
  assert.equal(prefs.webSecurity, true, "same-origin checks on");
  assert.equal(prefs.allowRunningInsecureContent, false);
  // Load-bearing, and measured rather than assumed: with this false the preload
  // does not run in a rozenite:// iframe at all, so no chrome.* exists.
  assert.equal(prefs.nodeIntegrationInSubFrames, true);
});

test("the window uses that table and does not re-widen it inline", () => {
  const source = readCode("src", "main", "window.js");
  assert.match(source, /frontendPreferences/, "preferences come from frame-security");
  assert.doesNotMatch(
    source,
    /webSecurity:\s*false|allowRunningInsecureContent:\s*true|sandbox:\s*false/,
    "no inline overrides"
  );
});

// ── the sendSync house rule is now unconditional ─────────────────────────────
test("no IPC channel is synchronous, and the injected-script channel is gone", () => {
  const names = Object.values(channels);
  assert.ok(names.length > 20, "the channel table still describes the whole substrate");
  assert.equal(names.includes("store-injected-script"), false);
  assert.equal(names.includes("get-injected-script"), false);

  for (const rel of [
    ["src", "preload", "index.js"],
    ["src", "preload", "frontend-host.js"],
    ["src", "preload", "extension-frame.js"],
    ["src", "main", "ipc.js"],
  ]) {
    const source = readCode(...rel);
    assert.doesNotMatch(source, /sendSync/, `${rel.join("/")}: no sendSync call`);
    assert.equal(
      /ipcMain\.on\s*\(/.test(source),
      false,
      `${rel.join("/")}: main registers async handlers only`
    );
  }

  const shared = readSource("src", "shared", "ipc.js");
  assert.match(shared, /House rule \(unconditional\)/, "the rule says so in one place");
});

test("the arbitrary-code-evaluation channel no longer exists anywhere", () => {
  assert.equal(fs.existsSync(path.join(REPO, "src", "main", "injected-scripts.js")), false);
  const preload = readCode("src", "preload", "extension-frame.js");
  assert.doesNotMatch(preload, /new Function/, "the extension frame evaluates nothing it is handed");
  assert.doesNotMatch(preload, /executeInMainWorld\(\{[\s\S]{0,40}new Function/);
  // The one executeInMainWorld that remains is the fixed chrome.* merge.
  assert.equal(preload.match(/executeInMainWorld/g).length, 1, "one fixed merge, no payloads");

  const host = readSource("src", "preload", "frontend-host.js");
  assert.match(host, /setInjectedScriptForOrigin/, "the frontend's call site still exists");
  assert.match(host, /\[STUB\] injected-script channel/, "and is documented as inert");
});

test("extension pages are not handed a raw ipcRenderer", () => {
  const preload = readCode("src", "preload", "extension-frame.js");
  assert.doesNotMatch(
    preload,
    /exposeInMainWorld\(\s*["']ipcRenderer/,
    "no raw ipcRenderer in the page world"
  );
  assert.doesNotMatch(
    preload,
    /exposeInMainWorld\(\s*["'](process|require|module|electron)["']/,
    "no other Node surface either"
  );
  // What the frame DOES expose: the chrome namespace under its bridge name.
  assert.match(preload, /exposeInMainWorld\("chromeElectron", chrome\)/);
});

test("chrome-shim stays free of window/ipcRenderer/Electron/transport references", () => {
  // The layering rule in docs/ARCHITECTURE.md, grep-verified as promised.
  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      return entry.isDirectory() ? walk(full) : [full];
    });

  const offenders = [];
  let checked = 0;
  for (const file of walk(path.join(REPO, "src", "chrome-shim"))) {
    if (!file.endsWith(".js") || file.endsWith(".map")) {
      continue;
    }
    checked++;
    const code = codeOf(fs.readFileSync(file, "utf8"));
    for (const pattern of [
      /\bwindow\b/,
      /\bipcRenderer\b/,
      /\bipcMain\b/,
      /require\(\s*["']electron["']\s*\)/,
      /document\./,
    ]) {
      if (pattern.test(code)) {
        offenders.push(`${path.basename(file)}: ${pattern}`);
      }
    }
  }
  assert.ok(checked >= 8, `expected to check the whole shim, saw ${checked} files`);
  assert.deepStrictEqual(offenders, []);
});
