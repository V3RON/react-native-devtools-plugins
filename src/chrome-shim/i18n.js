// chrome.i18n (docs/features/STORAGE-AND-I18N.md).
//
// `getMessage` and `getUILanguage` are SYNCHRONOUS in Chrome and extensions call them at
// the top of their first script, so the data has to be here before page scripts run.
// The frame preload therefore supplies `loadBundle` as a synchronous read of its own
// extension's message bundle (src/preload/extension-frame.js; src/main/i18n-host.js
// builds it and says why it is not an IPC call). It is invoked lazily on the first call
// and cached, so an extension that never touches i18n costs nothing.
//
//   - `loadBundle` throwing or returning nothing leaves the API alive with Chrome's
//     "no catalog" behaviour: every message is "" and only `@@extension_id` is known.
//   - `detectLanguage` is an honest "undetermined": Chrome ships the CLD3 model, which
//     this shell does not have, so it answers `{isReliable: false, languages: []}` —
//     a shape Chrome itself returns for text it cannot classify — instead of guessing.
const { promiseOrCallback } = require("./async-style");
const i18n = require("../shared/i18n");

/**
 * @param {object} deps
 * @param {string} deps.extensionId
 * @param {() => object|null} [deps.loadBundle] synchronous; see above
 * @param {{warn: Function}} [deps.logger]
 */
const createI18n = ({ extensionId, loadBundle = () => null, logger = console }) => {
  let bundle;
  const current = () => {
    if (bundle === undefined) {
      try {
        bundle = loadBundle() || null;
      } catch (error) {
        logger.warn(`[chrome.i18n] message bundle unavailable (${error && error.message}); messages will be empty`);
        bundle = null;
      }
      if (bundle === null) {
        // Same shape the host would have sent for an extension with no _locales.
        bundle = i18n.buildBundle({ extensionId, uiLocale: "en_US", catalogs: {} });
      }
    }
    return bundle;
  };

  return {
    getMessage: (...args) => i18n.getMessage(current(), args),

    getUILanguage: () => current().uiLanguage,

    // Chrome: a Promise when no callback is given (MV3), the callback otherwise.
    getAcceptLanguages: (callback) =>
      promiseOrCallback(() => [...current().acceptLanguages], callback),

    detectLanguage: (text, callback) =>
      promiseOrCallback(() => {
        if (typeof text !== "string") {
          throw new TypeError(
            "Error in invocation of i18n.detectLanguage(string text, optional function callback): No matching signature."
          );
        }
        return { isReliable: false, languages: [] };
      }, callback),
  };
};

module.exports = { createI18n };
