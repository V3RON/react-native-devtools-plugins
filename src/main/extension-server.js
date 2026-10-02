// The extension file server: maps `rozenite://<extension-id>/<path>` to
// `<extensionsDir>/<extension-id>/<path>`.
//
// Security: both the extension id and the inner path derive from an
// untrusted URL, so resolution is guarded against path traversal — a
// request can never escape its own extension directory. Every response also
// carries that extension's Content-Security-Policy (src/shared/csp.js), so an
// extension page gets Chrome's `script-src 'self'` unless its own manifest
// declares a policy.
const fs = require("fs");
const path = require("path");
const { protocol } = require("electron");
const config = require("./config");
const {
  EXTENSION_SCHEME,
  parseExtensionURL,
} = require("../shared/protocol");
const { contentSecurityPolicyFor, unsafeReason } = require("../shared/csp");

// Acceptable extension-id folder names (id == folder name == URL hostname).
const EXTENSION_ID_RE = /^[A-Za-z0-9._-]+$/;
const RESERVED_IDS = new Set([".", ".."]);

// net::ERR_FILE_NOT_FOUND
const FILE_NOT_FOUND = -6;

/**
 * Resolve an extension-relative path, or null if it escapes the extension dir.
 * `path.resolve` collapses `..` before the containment check, and the
 * `root + path.sep` prefix rule means one extension can never name a sibling
 * extension's file (`/…/extensions/ab` does not start with `/…/extensions/a/`).
 */
const resolveExtensionFile = (extensionId, innerPath) => {
  if (!EXTENSION_ID_RE.test(extensionId) || RESERVED_IDS.has(extensionId)) {
    return null;
  }
  const root = path.resolve(config.extensionsDir, extensionId);
  const target = path.resolve(root, innerPath);
  if (target !== root && !target.startsWith(root + path.sep)) {
    return null;
  }
  return target;
};

/**
 * The CSP to serve for one manifest. Chrome refuses to load an extension whose
 * declared policy weakens `script-src`/`object-src`; the honest equivalent here
 * is the strict default plus one console line naming the extension and the
 * reason — silently serving the weaker policy would be the unsafe answer.
 */
const policyForManifest = (manifest, extensionId = "", log = console) => {
  const policy = contentSecurityPolicyFor(manifest);
  const reason = unsafeReason(policy);
  if (reason) {
    log.warn(
      `[extensions] ${extensionId || "<unknown>"} declares an unsafe ` +
        `content_security_policy (${reason}) — serving Chrome's default policy instead.`
    );
    return contentSecurityPolicyFor({});
  }
  return policy;
};

// Must run before app ready.
const registerExtensionSchemePrivileges = () => {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: EXTENSION_SCHEME,
      // `standard` + `supportFetchAPI` are what make a `rozenite://` iframe
      // loadable inside the http:// frontend with webSecurity on; `bypassCSP`
      // keeps the frontend's own policy from applying to extension resources —
      // each response carries its extension's policy instead (verified in
      // tests/extension-frame-electron.test.js).
      privileges: { standard: true, supportFetchAPI: true, bypassCSP: true },
    },
  ]);
};

// Read + parse an extension's manifest.json (host-side, for chrome.runtime.
// getManifest and for the CSP above). Anything unreadable/invalid degrades to
// {} — same net effect as the pre-runtime-shim behavior.
const loadManifest = (extensionId) => {
  const filePath = resolveExtensionFile(extensionId, "manifest.json");
  if (!filePath) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return {};
  }
};

// Must run after app ready.
const registerExtensionProtocol = ({ log = console } = {}) => {
  const policies = new Map(); // extensionId -> {value, source}
  const policyFor = (extensionId) => {
    if (!policies.has(extensionId)) {
      policies.set(extensionId, policyForManifest(loadManifest(extensionId), extensionId, log));
    }
    return policies.get(extensionId);
  };

  protocol.registerFileProtocol(EXTENSION_SCHEME, (request, callback) => {
    const parsed = parseExtensionURL(request.url);
    const filePath =
      parsed && resolveExtensionFile(parsed.extensionId, parsed.innerPath);
    if (!filePath) {
      callback({ error: FILE_NOT_FOUND });
      return;
    }
    callback({
      path: filePath,
      headers: { "Content-Security-Policy": [policyFor(parsed.extensionId).value] },
    });
  });

  return policyFor;
};

module.exports = {
  resolveExtensionFile,
  loadManifest,
  policyForManifest,
  registerExtensionSchemePrivileges,
  registerExtensionProtocol,
};
