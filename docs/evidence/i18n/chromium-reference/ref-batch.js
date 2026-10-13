// node ref-batch.js <cases.js> [name-prefix] -> runs each case through ref-case.js (real Chromium)
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const specs = require(path.resolve(process.argv[2]));
const only = process.argv[3];
for (const [name, spec] of Object.entries(specs)) {
  if (only && !name.startsWith(only)) continue;
  const f = path.join(require("os").tmpdir(), "i18n-ref-spec.json");
  fs.writeFileSync(f, JSON.stringify(spec));
  let out;
  try { out = execFileSync("node", [path.join(__dirname, "ref-case.js"), f], { encoding: "utf8", timeout: 40000 }); } catch (e) { out = "ERR " + e.message; }
  console.log("== " + name + "\n" + out.trim());
}
