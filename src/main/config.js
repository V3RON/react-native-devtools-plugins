// Central configuration for the Electron main process.
// Every value is overridable via environment variables.
const path = require("path");

const repoRoot = path.join(__dirname, "..", "..");

module.exports = {
  repoRoot,

  // The RN DevTools frontend, served by the patched fork's Metro dev server.
  // See docs/ARCHITECTURE.md — this coupling is a known limitation.
  frontendURL:
    process.env.DEVTOOLS_FRONTEND_URL ||
    "http://127.0.0.1:8081/rozenite/rn_fusebox.html?ws=localhost:9223",

  // Root folder holding the unpacked extensions ("installed extensions").
  // (Step 5 of docs/REFACTORING.md moves this to <repoRoot>/extensions.)
  extensionsDir: process.env.DEVTOOLS_EXTENSIONS_DIR || repoRoot,

  preloadPath: path.join(repoRoot, "src/preload/index.js"),
};
