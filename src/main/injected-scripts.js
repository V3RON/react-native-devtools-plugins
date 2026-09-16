// Main-process store for per-origin injected scripts.
//
// The frontend hands a script to the host via
// InspectorFrontendHost.setInjectedScriptForOrigin (main-frame preload);
// extension frames later fetch and evaluate their origin's script
// (extension-frame preload). See docs/ARCHITECTURE.md.
const scripts = new Map();

const set = (origin, script) => scripts.set(origin, script);
const get = (origin) => scripts.get(origin);

module.exports = { set, get };
