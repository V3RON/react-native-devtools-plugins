// chrome.scripting — `executeScript` over the content bridge's `Runtime.evaluate`.
//
// The frame half does what Chrome does before anything leaves the extension: validate
// the injection, check the target is a tab that exists, and serialize `func` to source
// text (which is why a Chrome `func` cannot close over anything). Everything that
// touches the app — the opt-in gate, the world, the evaluate — is the host's
// (src/main/content-bridge.js `executeScript`).
//
// Not implemented, and failing rather than pretending: `insertCSS`/`removeCSS` (no CSS
// in an RN target), and `registerContentScripts` & co. (manifest `content_scripts` are
// the only registry this shell has). Both reject with a reason naming the gap.
const { promiseOrCallback } = require("./async-style");

const createScripting = ({ tabId, execute = null, lastError = null } = {}) => {
  const errorScope = lastError || {};

  const executeScript = async (injection) => {
    if (!injection || typeof injection !== "object") {
      throw new Error("scripting.executeScript: an injection object is required");
    }
    const target = injection.target || {};
    if (Number(target.tabId) !== tabId) {
      throw new Error(`No tab with id: ${target.tabId}.`);
    }
    const hasFiles = Array.isArray(injection.files) && injection.files.length > 0;
    // A string here is the main world's serialization of the caller's function
    // (src/preload/extension-frame.js), never something the API accepts from a page.
    const isFn = (value) => typeof value === "function" || typeof value === "string";
    const hasFunc = isFn(injection.func) || isFn(injection.function);
    if (hasFiles === hasFunc) {
      throw new Error("scripting.executeScript: exactly one of 'files' or 'func' must be specified");
    }
    if (!execute) {
      throw new Error(
        "scripting.executeScript: this context has no route to the inspected target"
      );
    }
    const fn = injection.func || injection.function;
    const outcome = await execute({
      files: hasFiles ? injection.files.map(String) : undefined,
      func: hasFunc ? String(fn) : undefined,
      args: Array.isArray(injection.args) ? injection.args : [],
      world: injection.world || "ISOLATED",
    });
    if (!outcome || !outcome.ok) {
      throw new Error((outcome && outcome.error) || "scripting.executeScript: the host did not answer");
    }
    return outcome.results;
  };

  const unsupported = (method, why) => (...args) => {
    const callback = typeof args[args.length - 1] === "function" ? args[args.length - 1] : undefined;
    return promiseOrCallback(
      () => {
        throw new Error(`scripting.${method}: ${why}`);
      },
      callback,
      errorScope
    );
  };
  const noRegistry = "dynamic content-script registration is not supported; declare content_scripts in the manifest";

  return {
    executeScript: (injection, callback) => promiseOrCallback(() => executeScript(injection), callback, errorScope),
    insertCSS: unsupported("insertCSS", "a React Native target has no CSS"),
    removeCSS: unsupported("removeCSS", "a React Native target has no CSS"),
    registerContentScripts: unsupported("registerContentScripts", noRegistry),
    unregisterContentScripts: unsupported("unregisterContentScripts", noRegistry),
    getRegisteredContentScripts: unsupported("getRegisteredContentScripts", noRegistry),
    updateContentScripts: unsupported("updateContentScripts", noRegistry),
    ExecutionWorld: { ISOLATED: "ISOLATED", MAIN: "MAIN" },
  };
};

module.exports = { createScripting };
