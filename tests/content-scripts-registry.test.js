// The host-side content-script registry (src/main/content-scripts.js + the scan in
// src/main/extensions.js) — GitHub issue #5.
//
// Three things the registry has to get right, each asserted here:
//   - manifest parsing: every field this host can act on, Chrome's defaults, and a
//     PROBLEM rather than a silent repair when a manifest entry is garbage;
//   - containment: a `js` path that escapes the extension folder is REFUSED through
//     the file server's own rules and never read — a manifest key is not a licence to
//     name another extension's file;
//   - a declared-but-missing file is REPORTED, not skipped, because a half-injected
//     extension is exactly the failure a developer cannot see.
//
// The folder is a temp dir and `config.extensionsDir` is redirected at CALL time —
// the same technique tests/extensions-scan.test.js uses, so no env-var gymnastics and
// no child process.
// Run: npm test
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const config = require("../src/main/config");
const {
  parseContentScripts,
  resolveDeclaredPath,
  resolveEntryPaths,
  readEntrySources,
  scanContentScriptExtensions,
} = require("../src/main/content-scripts");
const { scanContentScriptExtensions: scanInstalled } = require("../src/main/extensions");

const REAL_EXTENSIONS_DIR = config.extensionsDir;

/** An extensions folder with `files` written into it, for the duration of `run`. */
const withExtensions = (fixtures, run) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rozenite-content-"));
  for (const [id, files] of Object.entries(fixtures)) {
    for (const [innerPath, contents] of Object.entries(files)) {
      const target = path.join(root, id, innerPath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, typeof contents === "string" ? contents : JSON.stringify(contents));
    }
  }
  config.extensionsDir = root;
  try {
    return run(root);
  } finally {
    config.extensionsDir = REAL_EXTENSIONS_DIR;
    fs.rmSync(root, { recursive: true, force: true });
  }
};

const manifestWith = (contentScripts) => ({
  manifest_version: 3,
  name: "Fixture",
  content_scripts: contentScripts,
});

// ── parsing ──────────────────────────────────────────────────────────────────
test("a content_scripts entry parses into the fields this host acts on", () => {
  const { entries, problems } = parseContentScripts(
    manifestWith([
      {
        matches: ["https://www.graphdev.app/draft?*"],
        exclude_matches: ["*://*/private*"],
        js: ["a.js", "b.js"],
        css: ["overlay.css"],
        run_at: "document_end",
        world: "MAIN",
        all_frames: true,
      },
    ])
  );
  assert.deepStrictEqual(problems, []);
  assert.strictEqual(entries.length, 1);
  assert.deepStrictEqual(entries[0], {
    index: 0,
    matches: ["https://www.graphdev.app/draft?*"],
    excludeMatches: ["*://*/private*"],
    js: ["a.js", "b.js"],
    css: ["overlay.css"],
    runAt: "document_end",
    world: "MAIN",
    allFrames: true,
    matchAboutBlank: false,
  });
});

test("Chrome's defaults apply: document_idle, ISOLATED, no frames, no about:blank", () => {
  const { entries } = parseContentScripts(
    manifestWith([{ matches: ["<all_urls>"], js: ["x.js"] }])
  );
  assert.strictEqual(entries[0].runAt, "document_idle");
  assert.strictEqual(entries[0].world, "ISOLATED");
  assert.strictEqual(entries[0].allFrames, false);
  assert.strictEqual(entries[0].matchAboutBlank, false);
});

test("a manifest with no content_scripts is not a problem, and neither is an empty list", () => {
  assert.deepStrictEqual(parseContentScripts({ name: "x" }), { entries: [], problems: [] });
  assert.deepStrictEqual(parseContentScripts({ content_scripts: [] }), {
    entries: [],
    problems: [],
  });
});

test("a garbage content_scripts value is reported, not repaired into something injectable", () => {
  assert.deepStrictEqual(parseContentScripts({ content_scripts: "content.js" }), {
    entries: [],
    problems: ["content_scripts: expected an array, found string"],
  });
  const { entries, problems } = parseContentScripts({ content_scripts: ["x.js", 42] });
  assert.strictEqual(entries.length, 0);
  assert.deepStrictEqual(problems, [
    'content_scripts[0]: not an object, skipped',
    "content_scripts[1]: not an object, skipped",
  ]);
});

test("an entry missing matches or both of js/css is skipped WITH a reason", () => {
  const { entries, problems } = parseContentScripts(
    manifestWith([
      { js: ["no-matches.js"] },
      { matches: ["<all_urls>"] },
      { matches: ["<all_urls>"], js: [], css: [] },
    ])
  );
  assert.strictEqual(entries.length, 0);
  assert.ok(problems.some((p) => /\[0\]: no usable "matches"/.test(p)), problems.join("\n"));
  assert.ok(problems.some((p) => /\[1\]: declares neither/.test(p)), problems.join("\n"));
  assert.ok(problems.some((p) => /\[2\]: declares neither/.test(p)), problems.join("\n"));
});

test("an unknown run_at or world falls back to Chrome's default AND says so", () => {
  const { entries, problems } = parseContentScripts(
    manifestWith([
      { matches: ["<all_urls>"], js: ["x.js"], run_at: "document_later", world: "SECRETEST" },
    ])
  );
  assert.strictEqual(entries[0].runAt, "document_idle");
  assert.strictEqual(entries[0].world, "ISOLATED");
  assert.ok(problems.some((p) => /unknown run_at "document_later"/.test(p)), problems.join("\n"));
  assert.ok(problems.some((p) => /unknown world "SECRETEST"/.test(p)), problems.join("\n"));
});

test("a css-only entry is reported as a no-op here, not treated as injectable js", () => {
  const { entries, problems } = parseContentScripts(
    manifestWith([{ matches: ["<all_urls>"], css: ["overlay.css"] }])
  );
  assert.strictEqual(entries.length, 1);
  assert.deepStrictEqual(entries[0].js, []);
  assert.ok(
    problems.some((p) => /css-only; this host has no DOM/.test(p)),
    problems.join("\n")
  );
});

// ── containment ──────────────────────────────────────────────────────────────
test("a js path that escapes the extension folder is REFUSED through the file server's rules", () =>
  withExtensions(
    {
      victim: { "manifest.json": manifestWith({}), "secret.js": "globalThis.stolen = true;" },
      attacker: {
        "manifest.json": manifestWith([{ matches: ["<all_urls>"], js: ["../victim/secret.js"] }]),
      },
    },
    (root) => {
      // The guard itself: no path, and no read.
      assert.strictEqual(resolveDeclaredPath("attacker", "../victim/secret.js").ok, false);
      const resolved = resolveEntryPaths("attacker", {
        js: ["../victim/secret.js"],
        css: [],
      });
      assert.strictEqual(resolved.js[0].ok, false);
      assert.strictEqual(resolved.js[0].refused, true);
      assert.match(resolved.js[0].reason, /resolves outside extension "attacker"/);

      // And the refusal is enforced, not decorative: with mayRead always true, the
      // escaping path still yields no source.
      const read = readEntrySources("attacker", resolved, () => true);
      assert.deepStrictEqual(read.sources, []);
      assert.ok(read.problems.some((p) => /refused/.test(p)), read.problems.join("\n"));
      assert.ok(
        !read.problems.join("\n").includes(fs.readFileSync(path.join(root, "victim/secret.js"), "utf8")),
        "the refused file's contents never appear anywhere in the report"
      );
    }
  ));

test("a leading slash stays extension-relative, and a reserved path is refused", () =>
  withExtensions(
    { x: { "manifest.json": manifestWith({}), "ok.js": "1;" } },
    (root) => {
      for (const innerPath of ["../../../../../etc/passwd", "__rozenite_background__"]) {
        assert.strictEqual(
          resolveDeclaredPath("x", innerPath).ok,
          false,
          `${innerPath} must not resolve`
        );
      }
      // Chrome's own rule for manifest paths: a leading `/` is the extension's root,
      // not the filesystem's. The server's guard already normalizes it that way, and
      // content scripts inherit that rather than inventing a second rule.
      const leading = resolveDeclaredPath("x", "/etc/passwd");
      assert.strictEqual(leading.ok, true);
      assert.strictEqual(
        leading.filePath,
        path.join(path.resolve(root, "x"), "etc/passwd")
      );
      assert.strictEqual(resolveDeclaredPath("x", "ok.js").ok, true);
    }
  ));

test("a declared file that does not exist is reported, never silently dropped", () =>
  withExtensions(
    {
      x: {
        "manifest.json": manifestWith([{ matches: ["<all_urls>"], js: ["here.js", "gone.js"] }]),
        "here.js": "1;",
      },
    },
    () => {
      const parsed = parseContentScripts({
        content_scripts: [{ matches: ["<all_urls>"], js: ["here.js", "gone.js"], css: [] }],
      });
      const resolved = resolveEntryPaths("x", parsed.entries[0]);
      assert.strictEqual(resolved.js[0].ok, true);
      assert.strictEqual(resolved.js[1].ok, false);
      assert.strictEqual(resolved.js[1].missing, true);
      assert.match(resolved.js[1].reason, /gone\.js.*is not a file in x/);

      const read = readEntrySources("x", resolved, () => true);
      assert.strictEqual(read.sources.length, 1, "the file that exists is still read");
      assert.ok(read.problems.some((p) => /gone\.js/.test(p)), read.problems.join("\n"));
    }
  ));

// ── reading only what the gate allowed ───────────────────────────────────────
test("no source is read unless the caller's verdict allows it", () =>
  withExtensions(
    {
      x: {
        "manifest.json": manifestWith({}),
        "content.js": "globalThis.hooked = true;",
      },
    },
    () => {
      const resolved = resolveEntryPaths("x", { js: ["content.js"], css: [] });
      const denied = readEntrySources("x", resolved);
      assert.deepStrictEqual(denied.sources, [], "the default verdict reads nothing");
      assert.ok(
        denied.problems.some((p) => /not read: "content\.js"/.test(p)),
        denied.problems.join("\n")
      );

      const seen = [];
      const allowed = readEntrySources("x", resolved, (info) => {
        seen.push(info.kind);
        return true;
      });
      assert.deepStrictEqual(allowed.sources, [
        { innerPath: "content.js", source: "globalThis.hooked = true;" },
      ]);
      assert.deepStrictEqual(seen, ["js"]);
      assert.deepStrictEqual(allowed.problems, []);
    }
  ));

// ── the scan ─────────────────────────────────────────────────────────────────
test("the scan reports only folders that declare content scripts, manifests only", () =>
  withExtensions(
    {
      "with-scripts": {
        "manifest.json": manifestWith([{ matches: ["https://app.test/*"], js: ["c.js"] }]),
        "c.js": "1;",
      },
      "no-scripts": { "manifest.json": { name: "Plain", manifest_version: 3 } },
      "broken": { "manifest.json": { name: "Broken", content_scripts: "c.js" } },
    },
    (root) => {
      const found = scanInstalled().sort((a, b) => a.extensionId.localeCompare(b.extensionId));
      assert.deepStrictEqual(
        found.map((entry) => entry.extensionId),
        ["broken", "with-scripts"],
        "a folder with a malformed declaration is reported, not silently absent"
      );
      assert.strictEqual(found[0].problems.length, 1);
      assert.strictEqual(found[1].name, "Fixture");
      assert.strictEqual(found[1].entries.length, 1);

      // Manifests only: the scan never opened the script.
      const target = path.join(root, "with-scripts/c.js");
      const before = fs.readFileSync(target, "utf8");
      scanInstalled();
      assert.strictEqual(fs.readFileSync(target, "utf8"), before);
    }
  ));

test("the shipped graphql content script is parsed, and its pattern is kept verbatim", () => {
  const graphql = scanInstalled().find((entry) => entry.extensionId === "graphql");
  assert.ok(graphql, "extensions/graphql is installed in this repo");
  assert.strictEqual(graphql.entries.length, 1);
  assert.deepStrictEqual(graphql.entries[0].matches, ["https://www.graphdev.app/draft?*"]);
  assert.deepStrictEqual(graphql.entries[0].js, ["contentScript_export.js"]);
  assert.strictEqual(graphql.entries[0].runAt, "document_idle");
  assert.strictEqual(graphql.entries[0].world, "ISOLATED");
});

test("a missing extensions dir yields no extensions instead of throwing", () => {
  const missing = path.join(os.tmpdir(), "rozenite-does-not-exist-42");
  config.extensionsDir = missing;
  try {
    assert.deepStrictEqual(scanInstalled(), []);
    assert.deepStrictEqual(scanContentScriptExtensions(), []);
  } finally {
    config.extensionsDir = REAL_EXTENSIONS_DIR;
  }
});
