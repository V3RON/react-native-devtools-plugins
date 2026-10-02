// chrome.runtime namespace: identity, manifest, platform info, lifecycle
// events (docs/features/RUNTIME-MESSAGING.md).
//
//   - id === extensionId === rozenite URL hostname — load-bearing contract:
//     Altair regex-parses getURL() output to derive the id.
//   - Messaging (sendMessage / connect) is NOT part of this file: the
//     messaging client attaches those onto the namespace.
//   - Lifecycle events (onInstalled / onStartup) are registrable now; their
//     producer arrives with the background host (bucket 3).
const { createEvent } = require("./event");
const { promiseOrCallback } = require("./async-style");
const { buildExtensionURL } = require("../shared/protocol");

/**
 * @param {object} deps
 * @param {string} deps.extensionId
 * @param {() => object} deps.getManifest live manifest (may be {} until loaded)
 * @param {{os: string, arch: string}} deps.platform
 * @param {{value: any}} deps.lastError shared mutable holder — the messaging
 *        client sets it around callback invocations (Chrome scoping).
 * @param {() => Promise<{ok: boolean, url?: string, error?: string}>} [deps.openOptionsPage]
 *        host capability behind `runtime.openOptionsPage` (src/main/options-host.js).
 *        Absent = this context cannot have an options page opened for it, which the
 *        shim reports as Chrome's failure rather than a silent no-op.
 */
const createRuntime = ({
  extensionId,
  getManifest,
  platform,
  lastError,
  openOptionsPage = null,
}) => {
  const events = {
    onMessage: createEvent(),
    onConnect: createEvent(),
    onInstalled: createEvent(),
    onStartup: createEvent(),
    onSuspend: createEvent(),
    onUpdateAvailable: createEvent(),
  };

  const namespace = {
    id: extensionId,

    getURL: (innerPath = "") => buildExtensionURL(extensionId, innerPath),

    getManifest: () => getManifest(),

    // Chrome's answer here is honest and narrow: the background page's `window`
    // object. There is no window to hand out — the background context this shell
    // hosts is a hidden BrowserWindow whose WebContents the host does not expose
    // to other frames, and a devtools page in Chrome can only reach a real
    // background PAGE (MV2) window. So `undefined`, which is what Chrome returns
    // for an MV3 extension too: a service worker has no page to return either.
    // Nothing is fabricated (docs/features/BACKGROUND-WORKER.md).
    getBackgroundPage: () => undefined,

    getPlatformInfo: (callback) => promiseOrCallback(() => ({ ...platform }), callback),

    getPackages: (callback) => promiseOrCallback(() => [], callback),

    /**
     * `chrome.runtime.openOptionsPage` — Chrome opens the extension's
     * `options_ui.page`, and fails with lastError when the manifest does not
     * declare one. Only the host can tell either way (it owns the manifest on
     * disk and the window), so this delegates to an injected opener and reports
     * honestly what came back: a window that really opened, or lastError.
     * Without an opener (a context the host cannot open pages for, such as the
     * devtools frontend itself) it fails the same way Chrome fails an extension
     * with no options page — a silent no-op would leave an extension waiting
     * for a window that never appears.
     */
    openOptionsPage: (callback) =>
      promiseOrCallback(
        () =>
          Promise.resolve().then(() => {
            if (typeof openOptionsPage !== "function") {
              throw new Error(
                "Cannot open the options page: this host cannot open a page for this context."
              );
            }
            return openOptionsPage();
          }).then((reply) => {
            // The host says in one word whether a window appeared. Resolving on
            // `ok: false` would tell the extension an options page opened when the
            // host refused to open one, so the refusal becomes this call's failure.
            if (reply && reply.ok === false) {
              throw new Error(reply.error || "Cannot open the options page.");
            }
            return undefined;
          }),
        callback,
        {
          setError: (error) => {
            lastError.value = error.message;
          },
          clearError: () => {
            lastError.value = undefined;
          },
        }
      ),

    // No updater and no reload: those belong to a packaged install, which this
    // is not. Both stay inert, which is what an unpacked extension sees too.
    requestUpdate: (callback) => {
      if (callback) callback(false);
    },
    reload: () => {},

    // Scoped lastError: the messaging client sets/clears the holder around
    // listener and callback invocations; extensions branch on this.
    // Exposed as a data placeholder + an accessor helper — contextBridge
    // cloning loses live getters, so the frame preload re-defines `lastError`
    // as a real getter in the main world (see src/preload/extension-frame.js).
    lastError: null,
    _getLastLastError: () => lastError.value,
  };

  for (const [name, event] of Object.entries(events)) {
    namespace[name] = event;
  }

  return { namespace, events };
};

module.exports = { createRuntime };
