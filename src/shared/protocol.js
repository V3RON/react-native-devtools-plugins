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

const sanitizeIdPart = (value) => String(value).replace(/[^A-Za-z0-9.-]+/g, "-");

/**
 * The frontend View id (and iframe `name`) of the panel an extension creates at
 * `pagePath`: `ext.<len>.<extensionId>.<path>`. devtools' View rejects ids outside
 * [A-Za-z0-9.-] ("Invalid view ID"), so every other character is folded to `-`.
 *
 * The extension id is LENGTH-PREFIXED so the join is injective across extensions: a
 * plain `ext.<id>.<path>` made ("exta", "panel.html") and ("exta.panel", "html") the
 * same id, which let one extension take over another's panel events and window. Paths
 * within ONE extension that differ only in punctuation still fold together (replay and
 * dedupe treat them as one panel) — that cannot reach another extension.
 *
 * Shared because the host, the frontend bridge and the devtools-page shim must all derive
 * the SAME id from the same (extensionId, pagePath): that is what makes replay, dedupe and
 * the onShown(window) lookup agree.
 */
const panelIdFor = (extensionId, pagePath) => {
  const id = sanitizeIdPart(extensionId);
  const pathPart = sanitizeIdPart(String(pagePath || "").replace(/^\/+/, "") || "index");
  return `ext.${id.length}.${id}.${pathPart}`;
};

module.exports = { EXTENSION_SCHEME, parseExtensionURL, buildExtensionURL, panelIdFor };
