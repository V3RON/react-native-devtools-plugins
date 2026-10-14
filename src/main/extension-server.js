// The extension file server: maps `rozenite://<extension-id>/<path>` to
// `<extensionsDir>/<extension-id>/<path>`.
//
// Security: both the extension id and the inner path derive from an
// untrusted URL, so resolution is guarded against path traversal — a
// request can never escape its own extension directory, and neither can a
// symlink planted inside it: containment is decided on `fs.realpath`, not on
// path text (see `resolveInsideExtension`). The host-side reads that continue from
// that guard's ROOT by building their own names under it — the message bundle and the
// localized manifest/CSS — are contained by the same rule applied inside
// src/main/i18n-host.js, because a derived path never reaches the guard below.
// Every response also
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
  I18N_BUNDLE_PATH,
  parseExtensionURL,
} = require("../shared/protocol");
const { contentSecurityPolicyFor, unsafeReason } = require("../shared/csp");
const i18nHost = require("./i18n-host");

// Acceptable extension-id folder names (id == folder name == URL hostname).
const EXTENSION_ID_RE = /^[A-Za-z0-9._-]+$/;
const RESERVED_IDS = new Set([".", ".."]);

// Reserved inner path: the synthesized background bootstrap document
// (src/main/background-host.js asks for it). Reserved in BOTH directions — no
// file inside an extension folder can be served under this path, and a real
// folder named this cannot take the path either — see RESERVED_INNER_PATHS.
const BACKGROUND_BOOTSTRAP_PATH = "__rozenite_background__";
// Reserved the same way: the chrome.i18n message bundle of this extension, JSON, read
// synchronously by the frame's preload before any page script runs
// (src/main/i18n-host.js says why it travels over this protocol).
const RESERVED_INNER_PATHS = new Set([BACKGROUND_BOOTSTRAP_PATH, I18N_BUNDLE_PATH]);

/**
 * The containment guard for a REQUESTED path: the id must be a plausible folder
 * name, the inner path must resolve to something inside that folder (`path.resolve`
 * collapses `..` first, and the `root + path.sep` prefix rule means one
 * extension can never name a sibling's file — `/…/extensions/ab` does not start
 * with `/…/extensions/a/`), and the path must not be a reserved one.
 *
 * It is the only guard for paths a request names, but NOT the only place the rule
 * below is enforced: `containmentFor` in src/main/i18n-host.js applies the same
 * realpath rule to the paths THAT file derives for itself, which never come here.
 *
 * Containment is then checked on RESOLVED paths, not on path text (finding F1,
 * docs/SECURITY-PLATFORM.md §3.2). The string rule alone was not enough: every
 * read that follows this guard (`fs.statSync`, `net.fetch(file://)`) FOLLOWS
 * symlinks, so one link planted inside an extension folder — `stolen ->
 * ~/.ssh/id_ed25519` — made the folder's own page read arbitrary files with a
 * plain `fetch("stolen")`, no IPC and no prompt. So: one `lstat` says the root
 * is not itself a link, one `realpath` says what the root and the target
 * actually are, and the prefix rule is applied to those.
 *
 * Which is also where the two containment layers agree, stated once so nobody
 * re-derives it: A SYMLINKED FOLDER IS NEVER AN EXTENSION ROOT. The discovery
 * scan reaches folders through `readdir({ withFileTypes: true })` +
 * `isDirectory()` (src/main/extensions.js), which never reports a link, and the
 * server refuses a linked root for the same reason — otherwise the two would
 * disagree about what an extension is, and the disagreement would be the
 * permissive one. A link that stays INSIDE its extension folder keeps working:
 * the rule is about where a path lands, not about which directory entries are links.
 *
 * The guard returns the REALPATH, not the text-contained path, and that is the
 * second half of the rule: a caller that reads what this returns opens a path with
 * no link components left in it, so the read cannot be re-directed by a link that
 * appears after the check. Returning the text path would hand the caller a name
 * whose meaning can still change underneath it.
 *
 * The residual race, stated honestly: between the `realpath` here and the `open`
 * in the caller, another writer can still swap a PARENT DIRECTORY of the target,
 * and the inode opened is then not the inode checked. That window is a
 * confidentiality question — an extension page has no `fs`, so this server IS its
 * read channel, and a mid-flight swap is a read, not a corruption — and it is
 * closed only by opening a descriptor relative to a checked directory, which
 * `net.fetch(file://)` and the plain `fs` reads here cannot do. It is accepted for
 * the reason §7 item 7 gives: reaching it needs write access to the developer's own
 * `extensions/` folder, and that access already means rewriting the extension's
 * own files and running its own code. Integrity is not the mitigation being
 * claimed here; the point is that the remaining window needs the same privilege as
 * the thing we already accept.
 *
 * Scope of the platform behaviour: verified on macOS and Linux. On Windows,
 * `lstatSync().isSymbolicLink()` is false for NTFS junctions and other reparse
 * points, and the realpath prefix compare is case-sensitive on a case-insensitive
 * filesystem, so neither is covered by this rule or by these tests.
 *
 * @returns {string|null} the real (link-free) path for anything that exists, the
 * text-contained path for a name with nothing behind it (so a caller can still
 * answer "missing"), or null when the request is refused
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
  // Three sync syscalls per path, deliberately per request rather than cached: the
  // install folder is a LIVE folder whose contents change under us (docs/
  // SECURITY-PLATFORM.md §7, item 7), so caching these answers would be caching the
  // security decision, and a stale entry is exactly the window the rule is meant to
  // close. The folder is a developer's own and the calls are three stats at most.
  let isLink;
  try {
    isLink = fs.lstatSync(root).isSymbolicLink();
  } catch {
    // No such folder (or no permission to look): report the contained path and
    // let the caller's own existence check answer "missing", which is what it did
    // before this guard existed. Nothing can be read through a folder that is not
    // there — and nothing through a dangling link below it either, because stat
    // follows the link and fails.
    return target;
  }
  if (isLink) {
    return null; // the decided policy: see the docblock — the scanner skips it too
  }
  // Root and target are resolved in SEPARATE tries, because the two ENOENTs mean
  // different things: ENOENT on the root means this extension has no folder (the
  // scanner would not have offered it, so it is a refusal, not a missing file), while
  // ENOENT on the target means the extension is installed and the name it asked for is
  // simply not there — the honest "missing" src/main/content-scripts.js reports.
  // One shared `try` keyed the answer on whichever threw first, so a root that
  // vanished mid-call returned the text-contained target UNVALIDATED: the fail-open
  // attached to the wrong operand.
  let realRoot;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    return null;
  }
  let realTarget;
  try {
    realTarget = fs.realpathSync(target);
  } catch (error) {
    // ENOENT / ENOTDIR mean nothing can be BEHIND this path — it does not exist, or
    // a component of it is a plain file (a dangling link is ENOENT, and a link to a
    // file with segments left is ENOTDIR, so an escape cannot hide in either). That
    // is the caller's "does not exist" case, and it has to keep reporting the
    // contained name: src/main/content-scripts.js tells a developer a manifest path
    // that names no file is MISSING, and a blanket refusal would turn that honest
    // message into a false accusation of escaping the folder.
    // Any other failure (EACCES, ELOOP, …) is a path this server cannot say anything
    // about, so it is refused rather than guessed.
    return error && (error.code === "ENOENT" || error.code === "ENOTDIR") ? target : null;
  }
  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) {
    return null;
  }
  return realTarget;
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
//
// `__MSG_name__` is replaced here, from the extension's `_locales`, but ONLY in the
// fields Chrome localizes (name, short_name, description, action.default_title,
// commands.*.description, omnibox.keyword — src/shared/i18n.js). Everything else stays
// literal on purpose: a marker in host_permissions, the CSP or a script path must not
// make what an extension may DO depend on the UI language
// (docs/features/STORAGE-AND-I18N.md).
const loadManifest = (extensionId) => {
  const filePath = resolveExtensionFile(extensionId, "manifest.json");
  if (!filePath) {
    return {};
  }
  try {
    const rawText = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
    const manifest = JSON.parse(rawText);
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
      return {};
    }
    try {
      return i18nHost.localizeManifest({
        manifest,
        rawText,
        root: path.dirname(filePath),
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

  const serveI18nBundle = (extensionId) => {
    const root = resolveInsideExtension(extensionId, "");
    if (!root || !fs.existsSync(root)) {
      return notFound(extensionId, "i18n bundle for an unknown extension");
    }
    const bundle = i18nHost.loadBundle({
      root,
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
  const serveLocalizedCss = (extensionId, filePath) => {
    if (!i18nHost.cssUsesMessages(filePath)) {
      return null; // the common case: no marker, no extra read — net.fetch serves it
    }
    return new Response(
      i18nHost.localizeCssFile({
        text: fs.readFileSync(filePath, "utf8"),
        root: resolveInsideExtension(extensionId, ""),
        extensionId,
        uiLocaleOverride: config.uiLocale,
        log,
      }),
      { status: 200, headers: headersFor(extensionId, { "Content-Type": "text/css; charset=utf-8" }) }
    );
  };

  const serveFile = async (extensionId, innerPath) => {
    const filePath = resolveExtensionFile(extensionId, innerPath);
    if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      return notFound(extensionId, `no such file: ${innerPath || "<empty>"}`);
    }
    if (filePath.toLowerCase().endsWith(".css")) {
      try {
        const localized = serveLocalizedCss(extensionId, filePath);
        if (localized) {
          return localized;
        }
      } catch (error) {
        log.warn(`[i18n] ${extensionId}: ${innerPath} not localized (${error.message})`);
      }
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
