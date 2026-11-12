// The extension file server: maps `rozenite://<extension-id>/<path>` to that
// extension's package (../registry/packages), which today is the folder
// `<extensionsDir>/<extension-id>/`.
//
// Security: both the extension id and the inner path derive from an untrusted URL.
// This server never builds a filesystem path: it asks the package, and the package's
// containment rule (realpath-based for a folder, ../registry/packages/directory-package.js)
// decides what a name may reach. The host-side reads that build their own names — the
// message bundle and the localized manifest/CSS (../registry/i18n-host.js) — go through
// the same package, so the same rule covers them.
// Every response also
// carries that extension's Content-Security-Policy (src/electron/extensions/internal/scheme/csp.js), so an
// extension page gets Chrome's `script-src 'self'` unless its own manifest
// declares a policy.
//
// The handler is `protocol.handle`, not the deprecated `registerFileProtocol`:
// a file-only handler can serve nothing that is not already on disk, and the
// extension folder is a read-only install (dropping a folder in `extensions/` IS
// the install step). The background worker's bootstrap document is synthesized
// rather than shipped, so it has to be generated here — see
// BACKGROUND_BOOTSTRAP_PATH below and docs/features/BACKGROUND-WORKER.md.
const { Readable } = require("stream");
const { protocol } = require("electron");
const { settings: config } = require("../settings");
const {
  EXTENSION_SCHEME,
  I18N_BUNDLE_PATH,
  BACKGROUND_BOOTSTRAP_PATH,
  parseExtensionURL,
} = require("./protocol");
const { contentSecurityPolicyFor, unsafeReason } = require("./csp");
const { contentTypeFor } = require("./mime");
const i18nHost = require("../registry/i18n-host");
const { packageFor, resolveExtensionFile, resolveInsideExtension } = require("../registry/packages");

// Two inner paths are answered by this server itself, never from a package file
// (../scheme/protocol.js RESERVED_INNER_PATHS): BACKGROUND_BOOTSTRAP_PATH, the
// synthesized background bootstrap document (../contexts/background-host.js asks for
// it), and I18N_BUNDLE_PATH, the chrome.i18n message bundle the frame's preload reads
// synchronously before any page script runs (../registry/i18n-host.js says why).

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
//
// `__MSG_name__` is replaced here, from the extension's `_locales`, but ONLY in the
// fields Chrome localizes (name, short_name, description, action.default_title,
// commands.*.description, omnibox.keyword — src/electron/extensions/internal/registry/i18n.js). Everything else stays
// literal on purpose: a marker in host_permissions, the CSP or a script path must not
// make what an extension may DO depend on the UI language
// (docs/features/STORAGE-AND-I18N.md).
const loadManifest = (extensionId) => {
  const pkg = packageFor(extensionId);
  const rawText = pkg ? pkg.readText("manifest.json") : null;
  if (rawText === null) {
    return {};
  }
  try {
    const manifest = JSON.parse(rawText);
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
      return {};
    }
    try {
      return i18nHost.localizeManifest({
        manifest,
        rawText,
        // The package, so the message bundle is read under the same containment rule
        // and cached under the same key as the `__rozenite_i18n__` bundle the frame loads.
        pkg,
        extensionId,
        uiLocaleOverride: config.uiLocale,
      });
    } catch (error) {
      console.warn(`[i18n] ${extensionId}: manifest not localized (${error.message})`);
      return manifest;
    }
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
    <!-- Synthesized by the host (src/electron/extensions/internal/scheme/extension-server.js) for the extension's
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
/**
 * @param {object} [options]
 * @param {object} [options.protocol] the session's `protocol` (the host's partition);
 *        Electron's default-session `protocol` when omitted
 */
const registerExtensionProtocol = ({ log = console, protocol: target = protocol } = {}) => {
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
    const pkg = packageFor(extensionId);
    const script = pkg ? pkg.entry(requested) : { kind: "missing" };
    if (script.kind === "refused") {
      return notFound(extensionId, `bootstrap script outside the extension: ${requested}`);
    }
    if (script.kind !== "file") {
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

  const serveI18nBundle = (extensionId) => {
    const pkg = packageFor(extensionId);
    if (!pkg) {
      return notFound(extensionId, "i18n bundle for an unknown extension");
    }
    const bundle = i18nHost.loadBundle({
      pkg,
      extensionId,
      uiLocaleOverride: config.uiLocale,
      log,
    });
    return new Response(JSON.stringify(bundle), {
      status: 200,
      headers: headersFor(extensionId, { "Content-Type": "application/json; charset=utf-8" }),
    });
  };

  // CSS gets `__MSG_name__` (and `__MSG_@@bidi_dir__`) substituted, as in Chrome.
  const serveLocalizedCss = (extensionId, pkg, innerPath) => {
    if (!i18nHost.cssUsesMessages(pkg, innerPath)) {
      return null; // the common case: no marker — streamed like any other file
    }
    return new Response(
      i18nHost.localizeCssFile({
        text: pkg.readText(innerPath),
        pkg,
        extensionId,
        uiLocaleOverride: config.uiLocale,
        log,
      }),
      { status: 200, headers: headersFor(extensionId, { "Content-Type": "text/css; charset=utf-8" }) }
    );
  };

  const serveFile = (extensionId, innerPath) => {
    const pkg = packageFor(extensionId);
    const file = pkg ? pkg.entry(innerPath) : { kind: "missing" };
    if (file.kind !== "file") {
      return notFound(extensionId, `no such file: ${innerPath || "<empty>"}`);
    }
    if (innerPath.toLowerCase().endsWith(".css")) {
      try {
        const localized = serveLocalizedCss(extensionId, pkg, innerPath);
        if (localized) {
          return localized;
        }
      } catch (error) {
        log.warn(`[i18n] ${extensionId}: ${innerPath} not localized (${error.message})`);
      }
    }
    // Streamed from the package, with the type decided here (./mime.js) rather than by
    // Chromium's file:// loader, so a package that is not a folder is served the same way.
    const opened = pkg.open(innerPath);
    if (!opened) {
      return notFound(extensionId, `unreadable file: ${innerPath}`);
    }
    const type = contentTypeFor(innerPath);
    return new Response(Readable.toWeb(opened.stream), {
      status: 200,
      headers: headersFor(extensionId, {
        ...(type ? { "Content-Type": type } : {}),
        "Content-Length": String(opened.size),
      }),
    });
  };

  target.handle(EXTENSION_SCHEME, async (request) => {
    const parsed = parseExtensionURL(String(request.url).split("?")[0].split("#")[0]);
    if (!parsed) {
      return notFound(null, `not a ${EXTENSION_SCHEME} URL`);
    }
    const innerPath = parsed.innerPath.replace(/^\/+/, "");
    if (innerPath === BACKGROUND_BOOTSTRAP_PATH) {
      return serveBootstrap(parsed.extensionId, queryOf(request.url));
    }
    if (innerPath === I18N_BUNDLE_PATH) {
      return serveI18nBundle(parsed.extensionId);
    }
    return serveFile(parsed.extensionId, innerPath);
  });

  return policyFor;
};

module.exports = {
  BACKGROUND_BOOTSTRAP_PATH,
  I18N_BUNDLE_PATH,
  bootstrapDocument,
  resolveExtensionFile,
  resolveInsideExtension,
  loadManifest,
  policyForManifest,
  registerExtensionSchemePrivileges,
  registerExtensionProtocol,
};
