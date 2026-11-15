// The preload bundler (scripts/bundle-preload.js): a sandboxed preload can require only
// `electron` and a few built-ins, so the production preloads ship as one file each.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { bundle, collect, PRELOADS, SANDBOX_MODULES } = require("../scripts/bundle-preload");

const REPO = path.join(__dirname, "..");

const fixture = (t, files) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-preload-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, source] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), source);
  }
  return dir;
};

/** Run a bundle the way a sandboxed preload runs: `require` knows only sandbox modules. */
const runBundle = (source, provided = {}) => {
  const asked = [];
  const sandboxRequire = (name) => {
    asked.push(name);
    if (!(name in provided)) throw new Error(`sandbox has no ${name}`);
    return provided[name];
  };
  const context = { require: sandboxRequire, result: {} };
  vm.runInNewContext(source, context);
  return { result: context.result, asked };
};

test("CommonJS semantics survive: one cache, replaced exports, cycles, lazy requires", (t) => {
  const dir = fixture(t, {
    "entry.js": `
      const counter = require("./lib/counter");
      const same = require("./lib/counter.js");
      const { a } = require("./cycle/a");
      result.sameInstance = counter === same;
      result.count = counter.next() + counter.next();
      result.cycle = a();
      result.lazy = require("./lazy")();
      result.electron = require("electron").marker;
    `,
    "lib/counter.js": `let n = 0; module.exports = { next: () => ++n };`,
    "cycle/a.js": `exports.name = "a"; const b = require("./b"); exports.a = () => "a+" + b.b();`,
    "cycle/b.js": `const a = require("./a"); exports.b = () => "b(sees " + a.name + ")";`,
    "lazy/index.js": `module.exports = () => require("../lib/counter").next();`,
  });
  const { result, asked } = runBundle(bundle(path.join(dir, "entry.js")), {
    electron: { marker: "the sandbox's own electron" },
  });
  assert.equal(result.sameInstance, true, "one module instance per file");
  assert.equal(result.count, 3);
  assert.equal(result.cycle, "a+b(sees a)", "a cycle sees the partial exports");
  assert.equal(result.lazy, 3, "a lazy require resolves to the same cached module");
  assert.equal(result.electron, "the sandbox's own electron");
  assert.deepEqual(asked, ["electron"], "only sandbox modules reach the real require");
});

test("a require the sandbox could not satisfy fails the build, not the frame", (t) => {
  const dir = fixture(t, {
    "fs.js": `require("fs");`,
    "dynamic.js": `const name = "x"; require(name);`,
    "missing.js": `require("./nope");`,
    "prose.js": `// require("./nope") in a comment is not a dependency\nmodule.exports = 1;`,
  });
  assert.throws(() => bundle(path.join(dir, "fs.js")), /require\("fs"\) is not available to a sandboxed preload/);
  assert.throws(() => bundle(path.join(dir, "dynamic.js")), /without a string literal/);
  assert.throws(() => bundle(path.join(dir, "missing.js")), /cannot resolve require\("\.\/nope"\)/);
  assert.doesNotThrow(() => bundle(path.join(dir, "prose.js")));
});

test("the production preloads bundle, and reach nothing but electron", () => {
  for (const { entry } of PRELOADS) {
    const { modules } = collect(path.join(REPO, entry));
    const external = new Set();
    for (const { deps } of modules.values()) {
      for (const [specifier, id] of Object.entries(deps)) {
        if (id === null) external.add(specifier);
      }
    }
    assert.deepEqual([...external], ["electron"], `${entry} needs only electron`);
    assert.ok([...external].every((name) => SANDBOX_MODULES.has(name)));
  }
});
