// Frontend preferences store (InspectorFrontendHost.get/setPreference,
// previously empty stubs). Backed by electron-store so the frontend stops
// "forgetting" theme, experiments and panel sizing between launches.
const { default: Store } = require("electron-store");

const store = new Store({ name: "frontend-preferences" });

// Defaults registered via registerPreference (Chrome keeps these host-side).
const defaults = new Map();

const toDefaultValue = (name, options) => {
  // Upstream passes {synced?} in newer versions; devtools_compatibility.js
  // historically passes the default value directly (string) — honor both.
  if (typeof options === "string") return options;
  if (options && typeof options === "object" && "defaultValue" in options) {
    return String(options.defaultValue);
  }
  return undefined;
};

const register = (name, options) => {
  const value = toDefaultValue(name, options);
  if (value !== undefined) {
    defaults.set(name, value);
  }
};

const get = (name) => {
  const value = store.get(name);
  if (value !== undefined) {
    return value;
  }
  return defaults.get(name) ?? "";
};

const getAll = () => {
  const all = {};
  for (const [name, value] of defaults) {
    all[name] = value;
  }
  return Object.assign(all, store.store);
};

const set = (name, value) => store.set(name, value);
const remove = (name) => store.delete(name);
const clear = () => store.clear();

module.exports = { register, get, getAll, set, remove, clear };
