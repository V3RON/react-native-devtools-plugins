// Extension discovery (src/main/extensions.js): which folders become a devtools
// page and which become a background context (GitHub issue #3).
//
// `config` is required before the scanner is pointed at a temp folder because
// `scanExtensions` / `scanBackgroundExtensions` read `config.extensionsDir` at
// CALL time, not at import — which is what makes the folder under test
// injectable without env-var gymnastics or a child process. The real
// `extensions/` folder is asserted too, so the shipped manifests cannot drift
// away from what the scanner claims to understand.
// Run: npm test
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const config = require("../src/main/config");
const { scanExtensions, scanBackgroundExtensions } = require("../src/main/extensions");

const REPO = path.join(__dirname, "..");
const REAL_EXTENSIONS_DIR = config.extensionsDir;

/**
 * readdir order is filesystem order, not sorted order, so every comparison of a
 * scan's result goes through this: the scans are asserted on CONTENT and shape,
 * not on the order the folder happens to be stored in.
 */
const byId = (entries) =>
  [...entries].sort((a, b) => String(a.extensionId).localeCompare(String(b.extensionId)));

/** Point the scanner at a throwaway extensions folder for the duration of `run`. */
const withExtensionsDir = (manifests, run) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rozenite-scan-"));
  for (const [id, manifest] of Object.entries(manifests)) {
    const dir = path.join(root, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest));
  }
  config.extensionsDir = root;
  try {
    return run(root);
  } finally {
    config.extensionsDir = REAL_EXTENSIONS_DIR;
    fs.rmSync(root, { recursive: true, force: true });
  }
};

test("a background is discovered from `service_worker` and from legacy `scripts`", () => {
  withExtensionsDir(
    {
      "mv3-worker": {
        name: "MV3",
        manifest_version: 3,
        background: { service_worker: "background.js" },
      },
      "legacy-scripts": {
        name: "Legacy",
        manifest_version: 2,
        background: { scripts: ["assets/background.js"] },
      },
      "esm-worker": {
        name: "ESM",
        manifest_version: 3,
        background: { service_worker: "bg.js", type: "module" },
      },
    },
    () => {
      assert.deepStrictEqual(byId(scanBackgroundExtensions()), [
        { extensionId: "esm-worker", name: "ESM", script: "bg.js", type: "module" },
        {
          extensionId: "legacy-scripts",
          name: "Legacy",
          script: "assets/background.js",
          type: "classic",
        },
        {
          extensionId: "mv3-worker",
          name: "MV3",
          script: "background.js",
          type: "classic",
        },
      ]);
    }
  );
});

test("`service_worker` wins when both keys are present, and only type: module is module", () => {
  withExtensionsDir(
    {
      both: {
        background: {
          service_worker: "worker.js",
          scripts: ["old.js", "older.js"],
          type: "module",
        },
      },
      "bad-type": { background: { service_worker: "worker.js", type: "classic" } },
      "empty-sw": { background: { service_worker: "", scripts: ["fallback.js"] } },
    },
    () => {
      const found = Object.fromEntries(
        scanBackgroundExtensions().map((entry) => [entry.extensionId, entry])
      );
      assert.strictEqual(found.both.script, "worker.js", "service_worker wins");
      assert.strictEqual(found.both.type, "module");
      assert.strictEqual(found["bad-type"].type, "classic", "anything but module is classic");
      // An empty service_worker string is not a declaration; scripts[0] is.
      assert.strictEqual(found["empty-sw"].script, "fallback.js");
    }
  );
});

test("a background that is not declared is not discovered, in any shape", () => {
  withExtensionsDir(
    {
      none: { name: "no background at all", devtools_page: "devtools.html" },
      "empty-object": { background: {} },
      "empty-scripts": { background: { scripts: [] } },
      "null-background": { background: null },
      "string-background": { background: "background.js" },
      "non-string-script": { background: { scripts: [42] } },
    },
    () => {
      assert.deepStrictEqual(scanBackgroundExtensions(), []);
    }
  );
});

test("an extension with both a devtools page and a background appears in BOTH scans", () => {
  withExtensionsDir(
    {
      "both-contexts": {
        name: "Both",
        devtools_page: "devtools.html",
        background: { service_worker: "background.js" },
      },
      "devtools-only": { name: "Panel only", devtools_page: "devtools.html" },
      "background-only": { name: "Worker only", background: { service_worker: "bg.js" } },
    },
    () => {
      assert.deepStrictEqual(
        byId(scanExtensions()).map((entry) => entry.extensionId),
        ["both-contexts", "devtools-only"]
      );
      assert.deepStrictEqual(
        byId(scanBackgroundExtensions()).map((entry) => entry.extensionId),
        ["background-only", "both-contexts"]
      );
    }
  );
});

test("no extensions dir at all yields no extensions, in either scan", () => {
  config.extensionsDir = path.join(os.tmpdir(), "rozenite-scan-does-not-exist");
  try {
    assert.deepStrictEqual(scanExtensions(), []);
    assert.deepStrictEqual(scanBackgroundExtensions(), []);
  } finally {
    config.extensionsDir = REAL_EXTENSIONS_DIR;
  }
});

test("the shipped extensions resolve the way the manifests say", () => {
  config.extensionsDir = REAL_EXTENSIONS_DIR;
  const backgrounds = Object.fromEntries(
    scanBackgroundExtensions().map((entry) => [entry.extensionId, entry])
  );

  // GraphQL Network Inspector: a plain classic service worker.
  assert.deepStrictEqual(backgrounds.graphql, {
    extensionId: "graphql",
    name: "GraphQL Network Inspector",
    script: "background.js",
    type: "classic",
  });

  // Altair: the real-world awkward one — a service_worker, a legacy scripts
  // array pointing at the same file, and an ESM build.
  assert.deepStrictEqual(backgrounds.altair, {
    extensionId: "altair",
    name: "Altair GraphQL Client",
    script: "assets/background.js",
    type: "module",
  });

  // sample-extension has a devtools page and NO background, so it is a
  // devtools-page-only folder: present in one scan, absent from the other.
  assert.strictEqual(backgrounds["sample-extension"], undefined);
  assert.ok(
    scanExtensions().some((entry) => entry.extensionId === "sample-extension"),
    "sample-extension is still a devtools page"
  );

  // Every discovered script actually exists on disk — a worker that cannot be
  // served is a worker that silently never runs.
  for (const entry of Object.values(backgrounds)) {
    const file = path.join(REAL_EXTENSIONS_DIR, entry.extensionId, entry.script);
    assert.ok(fs.existsSync(file), `${entry.extensionId}: ${entry.script} exists`);
  }
});
