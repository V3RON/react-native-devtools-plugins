// The extension file server: maps `rozenite://<extension-id>/<path>` to
// `<extensionsDir>/<extension-id>/<path>`.
//
// Security: both the extension id and the inner path derive from an
// untrusted URL, so resolution is guarded against path traversal — a
// request can never escape its own extension directory. Every response also
// carries that extension's Content-Security-Policy (src/shared/csp.js), so an
// extension page gets Chrome's `script-src 'self'` unless its own manifest
// declares a policy.
//
// The handler is `protocol.handle`, not the deprecated `registerFileProtocol`:
// a file-only handler can serve nothing that is not already on disk, and the
// extension folder is a read-only install (dropping a folder in `extensions/` IS
// the install step). The background worker's bootstrap document is synthesized
// rather than shipped, so it has to be generated here — see
// BACKGROUND_BOOTSTRAP_PATH below and docs/features/BACKGROUND-WORKER.md.
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const { protocol, net } = require("electron");
const config = require("./config");
const {
  EXTENSION_SCHEME,
  parseExtensionURL,
} = require("../shared/protocol");
const { contentSecurityPolicyFor, unsafeReason } = require("../shared/csp");

// Acceptable extension-id folder names (id == folder name == URL hostname).
const EXTENSION_ID_RE = /^[A-Za-z0-9._-]+$/;
const RESERVED_IDS = new Set([".", ".."]);

// Reserved inner path: the synthesized background bootstrap document
// (src/main/background-host.js asks for it). Reserved in BOTH directions — no
// file inside an extension folder can be served under this path, and a real
// folder named this cannot take the path either — see RESERVED_INNER_PATHS.
const BACKGROUND_BOOTSTRAP_PATH = "__rozenite_background__";
const RESERVED_INNER_PATHS = new Set([BACKGROUND_BOOTSTRAP_PATH]);

/**
 * The containment guard, in one place: the id must be a plausible folder name,
 * the inner path must resolve to something inside that folder (`path.resolve`
 * collapses `..` first, and the `root + path.sep` prefix rule means one
 * extension can never name a sibling's file — `/…/extensions/ab` does not start
 * with `/…/extensions/a/`), and the path must not be a reserved one.
 *
 * @returns {string|null} the absolute path, or null when the request is refused
 */
const resolveInsideExtension = (extensionId, innerPath) => {
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
 * Resolve an extension-relative path to a FILE that may be served, or null.
 * Identical containment rules to `resolveInsideExtension`, plus the reserved
 * paths: a bootstrap request must never be answered from a file that happens to
 * exist at that name, because then the generated document would be whatever the
 * extension wrote there instead of what this server generated.
 */
const resolveExtensionFile = (extensionId, innerPath) => {
  const normalized = String(innerPath || "").replace(/^\/+/, "");
  if (RESERVED_INNER_PATHS.has(normalized)) {
    return null;
  }
  return resolveInsideExtension(extensionId, normalized);
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

/**
 * The bootstrap document a background worker loads, synthesized because the
 * extension folder is a read-only install and its CSP (`script-src 'self'`)
 * refuses any inline `<script>` this host might want to write. So the document's
 * ONLY body content is one same-origin `src=` tag — same-origin script loads are
 * exactly what `script-src 'self'` permits.
 *
 * `script` is already resolved and containment-checked by the caller; it is
 * inserted URL-encoded and quoted, so a path with punctuation cannot break out
 * of the attribute it lands in.
 */
const bootstrapDocument = ({ script, type }) =>
  `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <!-- Synthesized by the host (src/main/extension-server.js) for the extension's
         background context. No inline script: this document is served under the
         extension's own CSP, where 'self' permits src= and refuses inline. -->
    <title>Background context</title>
  </head>
  <body>
    <script src="${encodeURI(script)}"${type === "module" ? ' type="module"' : ""}></script>
  </body>
</html>
`;

/** Query part of a URL, without the fragment ("" when there is none). */
const queryOf = (rawURL) => {
  const index = String(rawURL).indexOf("?");
  return index === -1 ? "" : String(rawURL).slice(index + 1).split("#")[0];
};

// Must run after app ready.
//
// `protocol.handle` replaces the deprecated `registerFileProtocol` because this
// server now answers one request kind that has no file behind it: the background
// bootstrap document. Guard semantics are unchanged and still asserted —
// traversal blocked, no sibling-extension reads, reserved paths unreachable from
// disk, unknown id 404 — and every response still carries that extension's CSP.
const registerExtensionProtocol = ({ log = console } = {}) => {
  const policies = new Map(); // extensionId -> {value, source}
  const policyFor = (extensionId) => {
    if (!policies.has(extensionId)) {
      policies.set(extensionId, policyForManifest(loadManifest(extensionId), extensionId, log));
    }
    return policies.get(extensionId);
  };
  const headersFor = (extensionId, extra = {}) => ({
    ...extra,
    "Content-Security-Policy": policyFor(extensionId).value,
  });
  const notFound = (extensionId, why) => {
    log.warn(`[rozenite://] refused ${String(why)} (extension ${extensionId || "<none>"})`);
    return new Response("Not found", {
      status: 404,
      headers: extensionId ? headersFor(extensionId) : {},
    });
  };

  const serveBootstrap = (extensionId, search) => {
    // The script path arrives in the query string but is NEVER trusted from it:
    // it goes through the same containment rules as a real file request, so a
    // crafted `?script=../sibling/x.js` is refused exactly like a direct request
    // to that file would be.
    const requested = new URLSearchParams(search).get("script");
    if (!requested) {
      return notFound(extensionId, "bootstrap request without ?script=");
    }
    const filePath = resolveExtensionFile(extensionId, requested);
    if (!filePath) {
      return notFound(extensionId, `bootstrap script outside the extension: ${requested}`);
    }
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      return notFound(extensionId, `bootstrap script does not exist: ${requested}`);
    }
    const type = new URLSearchParams(search).get("type") === "module" ? "module" : "classic";
    return new Response(
      bootstrapDocument({ script: requested.replace(/^\/+/, ""), type }),
      {
        status: 200,
        headers: headersFor(extensionId, { "Content-Type": "text/html; charset=utf-8" }),
      }
    );
  };

  const serveFile = async (extensionId, innerPath) => {
    const filePath = resolveExtensionFile(extensionId, innerPath);
    if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      return notFound(extensionId, `no such file: ${innerPath || "<empty>"}`);
    }
    // net.fetch (file://) so Chromium picks the MIME type: a module script with
    // the wrong type is a hard load failure, and guessing here would be worse
    // than the one `try` that follows.
    try {
      const upstream = await net.fetch(pathToFileURL(filePath).href);
      const headers = new Headers(upstream.headers);
      headers.set("Content-Security-Policy", policyFor(extensionId).value);
      return new Response(upstream.body, { status: upstream.status, headers });
    } catch (error) {
      log.warn(`[rozenite://] net.fetch failed for ${filePath}: ${error.message}`);
      try {
        return new Response(fs.readFileSync(filePath), {
          status: 200,
          headers: headersFor(extensionId),
        });
      } catch (readError) {
        return notFound(extensionId, `unreadable file: ${readError.message}`);
      }
    }
  };

  protocol.handle(EXTENSION_SCHEME, async (request) => {
    const parsed = parseExtensionURL(String(request.url).split("?")[0].split("#")[0]);
    if (!parsed) {
      return notFound(null, `not a ${EXTENSION_SCHEME} URL`);
    }
    const innerPath = parsed.innerPath.replace(/^\/+/, "");
    if (innerPath === BACKGROUND_BOOTSTRAP_PATH) {
      return serveBootstrap(parsed.extensionId, queryOf(request.url));
    }
    return serveFile(parsed.extensionId, innerPath);
  });

  return policyFor;
};

module.exports = {
  BACKGROUND_BOOTSTRAP_PATH,
  bootstrapDocument,
  resolveExtensionFile,
  resolveInsideExtension,
  loadManifest,
  policyForManifest,
  registerExtensionSchemePrivileges,
  registerExtensionProtocol,
};
