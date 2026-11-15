// The extension host's configuration, in one place, set by `createExtensionHost`
// (./ExtensionHost.js) from the config the embedding shell passes in.
//
// Nothing under extensions/ reads `process.env` or the shell's own config module: the
// shell decides (src/electron/shell/config.js maps today's DEVTOOLS_* variables), and
// this object is what the internals see. It is process-wide because v1 hosts one
// window (docs/SPEC-DEBUGGER-SHELL-EXTENSIONS.md §5.3); `reset()` puts the defaults
// back when the host is disposed.
//
// The defaults are inert: no extensions folder, no content scripts, nothing opened by
// chrome.tabs, real-time alarms and no test seams. Unit tests set the one field they
// exercise and restore it afterwards.

const DEFAULTS = Object.freeze({
  // Root folder holding the unpacked extensions. null = no extensions.
  extensionsDir: null,
  // chrome.i18n UI locale override (`pt-BR`, `de`...). "" = what Electron resolved.
  uiLocale: "",
  // chrome.tabs.create policy: "none" | "external" | "window".
  tabsOpen: "none",
  // Content-script allowlist (comma/space list of ids, or `<all_rn_targets>`). null = none.
  contentScripts: null,
  // `<extensionId>[/<pagePath>]`: select that panel the first time it registers. null = off.
  showPanel: null,
  // chrome.alarms clock multiplier. Travels in RUNTIME_REGISTER replies, so a number.
  alarmClockScale: 1,
  // Test seams (unpackaged runs only; the shell decides): see src/electron/shell/config.js.
  testOpenLog: null,
  testSaveDialog: null,
});

const settings = { ...DEFAULTS };

/** Replace every value: anything not named in `values` returns to its default. */
const configure = (values = {}) => {
  for (const key of Object.keys(settings)) {
    delete settings[key];
  }
  Object.assign(settings, DEFAULTS);
  for (const [key, value] of Object.entries(values)) {
    if (key in DEFAULTS && value !== undefined) {
      settings[key] = value;
    }
  }
  return settings;
};

const reset = () => configure({});

module.exports = { DEFAULTS, settings, configure, reset };
