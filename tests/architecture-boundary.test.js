// The extension host's module boundary (docs/SPEC-DEBUGGER-SHELL-EXTENSIONS.md §5.1, §5.3):
//
//   - src/electron/extensions/index.js is the only file the shell may import;
//     everything under extensions/internal is the host's own.
//   - nothing under extensions/ imports the shell, or reads the environment: the
//     embedder decides, and passes its decision to createExtensionHost.
//
// The development shell has exactly two allowlisted reaches into the internals, both for
// its own InspectorFrontendHost replacement, which is not ported (spec §4). A new one is a
// decision, not an accident, so it has to be added here.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const REPO = path.join(__dirname, "..");
const SHELL = path.join(REPO, "src", "electron", "shell");
const EXTENSIONS = path.join(REPO, "src", "electron", "extensions");

const ALLOWED_SHELL_REACHES = new Map([
  ["host-files.js", ["../extensions/internal/services/save-service"]],
  ["ipc.js", ["../extensions/internal/services/external-open"]],
]);

const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : entry.name.endsWith(".js") ? [full] : [];
  });

/** Code without comments, so a path named in prose is not an import. */
const codeOf = (file) =>
  fs
    .readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");

const requiresOf = (file) =>
  [...codeOf(file).matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((match) => match[1]);

test("the shell reaches the extension host through its public entry only", () => {
  for (const file of walk(SHELL)) {
    const name = path.relative(SHELL, file);
    const reaches = requiresOf(file).filter((spec) => spec.includes("extensions/"));
    const allowed = ALLOWED_SHELL_REACHES.get(name) || [];
    for (const spec of reaches) {
      const resolved = path.resolve(path.dirname(file), spec);
      const isPublic = resolved === EXTENSIONS || resolved === path.join(EXTENSIONS, "index.js");
      assert.ok(
        isPublic || allowed.includes(spec),
        `src/electron/shell/${name} imports ${spec}: only ../extensions (index.js) is public`
      );
    }
  }
});

test("the extension host imports nothing from the shell and reads no environment", () => {
  for (const file of walk(EXTENSIONS)) {
    const name = path.relative(REPO, file);
    for (const spec of requiresOf(file)) {
      if (!spec.startsWith(".")) {
        continue;
      }
      const resolved = path.resolve(path.dirname(file), spec);
      assert.ok(
        resolved.startsWith(EXTENSIONS + path.sep) || resolved === EXTENSIONS,
        `${name} imports ${spec}, outside src/electron/extensions`
      );
    }
    assert.doesNotMatch(codeOf(file), /process\.env/, `${name} reads process.env`);
    // Channels go on each attached WebContents (broker/ipc.js attachContents), so the
    // embedder's own ipcMain stays the embedder's (spec §5.5).
    assert.doesNotMatch(codeOf(file), /\bipcMain\b/, `${name} uses the global ipcMain`);
  }
});

test("the public entry exposes the spec's API and nothing internal", () => {
  const api = require("../src/electron/extensions");
  assert.deepStrictEqual(Object.keys(api).sort(), ["createExtensionHost", "registerExtensionSchemes"]);
  const source = codeOf(path.join(EXTENSIONS, "index.js"));
  // The host object it returns has the three methods and no test views.
  assert.match(source, /webPreferences: host\.webPreferences,\s*attachWindow: host\.attachWindow,\s*dispose: host\.dispose,\s*\}/);
  assert.doesNotMatch(source, /_internals/);
});

test("nothing under extensions/internal builds a service at import time", () => {
  // The old shape: a module-level `let instance` behind a lazy getter, or a service
  // constructed at the top level. Every service is created by createExtensionHost now.
  // The preload is exempt: it runs once per frame, in the renderer, and building that
  // frame's chrome.* at load is its whole job.
  const preload = path.join(EXTENSIONS, "internal", "preload") + path.sep;
  for (const file of walk(path.join(EXTENSIONS, "internal")).filter((f) => !f.startsWith(preload))) {
    const code = codeOf(file);
    const name = path.relative(REPO, file);
    assert.doesNotMatch(code, /^let instance\b/m, `${name} keeps a module singleton`);
    assert.doesNotMatch(
      code,
      /^const \w+ = create[A-Z]\w*\(/m,
      `${name} creates a service at import time`
    );
  }
});
