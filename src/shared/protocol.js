// Cross-realm contracts for the extension protocol (no behavior here).
//
// Extension pages are served under a custom scheme so that the DevTools
// frontend can host them in iframes:
//
//   rozenite://<extension-id>/<path>  ->  <extensionsDir>/<extension-id>/<path>
//
// Note: extension id == hostname is a load-bearing contract (some extensions
// regex-parse chrome.runtime.getURL() output to derive their id).

const EXTENSION_SCHEME = "rozenite";

/**
 * Parse `rozenite://<extension-id>/<path>`.
 * @returns {{ extensionId: string, innerPath: string } | null}
 */
const parseExtensionURL = (url) => {
  if (!url.startsWith(`${EXTENSION_SCHEME}://`)) {
    return null;
  }
  const parts = url.split("/");
  // ["rozenite:", "", "<extension-id>", ...pathSegments]
  const extensionId = parts[2];
  if (!extensionId) {
    return null;
  }
  return { extensionId, innerPath: parts.slice(3).join("/") };
};

/** Build a `rozenite://` URL for an extension-relative path. */
const buildExtensionURL = (extensionId, innerPath = "") =>
  `${EXTENSION_SCHEME}://${extensionId}/${innerPath.replace(/^\//, "")}`;

module.exports = { EXTENSION_SCHEME, parseExtensionURL, buildExtensionURL };
