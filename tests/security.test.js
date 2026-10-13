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
