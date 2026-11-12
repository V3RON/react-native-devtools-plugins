// The extension host's public API (docs/SPEC-DEBUGGER-SHELL-EXTENSIONS.md §5.1).
//
// This is the only file code outside src/electron/extensions/ may import; everything
// else lives under ./internal and is asserted unreachable from the shell
// (tests/architecture-boundary.test.js).
//
//   registerExtensionSchemes()                 before app 'ready'; idempotent
//   createExtensionHost(config, {partition})   after 'ready'; builds every service
//     .webPreferences(base)                    the embedder's preferences + the frame policy
//     .attachWindow(win, frontendUrl)          before loadURL; v1: the first window wins
//     .dispose()                               on 'will-quit'
//
// `config` is decided by the embedder. This repository's development shell maps the
// DEVTOOLS_* environment onto it (src/electron/shell/config.js); upstream will parse
// launch flags instead (spec §5.9).
const { registerExtensionSchemePrivileges } = require("./internal/scheme/extension-server");
const { createExtensionHost: createHost } = require("./internal/ExtensionHost");

let schemesRegistered = false;

/** Must run before app 'ready' (protocol.registerSchemesAsPrivileged). Idempotent. */
const registerExtensionSchemes = () => {
  if (!schemesRegistered) {
    schemesRegistered = true;
    registerExtensionSchemePrivileges();
  }
};

/**
 * @param {object} config extensionsDir (required to host anything), contentScripts,
 *        and the development options listed in ./internal/settings.js; `cdp` holds the
 *        host's CDP session options (requestTimeoutMs, …)
 * @param {{partition?: string}} [options] the session the embedder's windows use
 * @returns {{
 *   webPreferences: (base: object) => object,
 *   attachWindow: (win: Electron.BrowserWindow, frontendUrl: string) => ({detach: () => Promise<void>} | null),
 *   dispose: () => Promise<void>,
 * }}
 */
const createExtensionHost = (config, options = {}) => {
  const host = createHost(config, options);
  return {
    webPreferences: host.webPreferences,
    attachWindow: host.attachWindow,
    dispose: host.dispose,
  };
};

module.exports = { registerExtensionSchemes, createExtensionHost };
