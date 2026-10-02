// Chrome's `content_security_policy` manifest key -> the header a
// `rozenite://` response carries (docs/features/EXTENSION-MANAGEMENT.md).
//
// Chrome's own MV3 policy, applied verbatim when an extension declares no CSP:
//
//   script-src 'self'; object-src 'self'
//   // plus `wasm-unsafe-eval` when the extension has a service worker
//   // (developer.chrome.com/docs/extensions/develop/concepts/content-security-policy)
//
// The default matters more than the override: with no header at all an
// extension folder — an unpacked Chrome Web Store build, source unseen — could
// ship an inline `<script>` plus `eval`, which is how an extension normally
// gets arbitrary code execution. Chrome does not allow that, so neither do we.
//
// `extension_pages` is the only key this host can honor: it is the policy for
// the extension's own pages, which is exactly what `rozenite://` serves.
// `sandbox_pages` would apply to a sandboxed page, and this shell serves every
// extension file through one protocol with one policy per extension.
//
// Nothing here is invented: an unusable or malformed declaration falls back to
// the default rather than to "no policy" (docs/LIMITATIONS.md honesty rule).
const DEFAULT_EXTENSION_PAGES_CSP = "script-src 'self'; object-src 'self'";

/** MV3 relaxes `script-src` for service-worker extensions — nothing else. */
const hasServiceWorker = (manifest) =>
  Boolean(manifest && manifest.background && typeof manifest.background.service_worker === "string");

/** Chrome's default, adjusted the one way Chrome adjusts it. */
const defaultCspFor = (manifest) =>
  hasServiceWorker(manifest)
    ? "script-src 'self' wasm-unsafe-eval; object-src 'self'"
    : DEFAULT_EXTENSION_PAGES_CSP;

/**
 * Normalize one declaration to a header value, or null when it cannot be
 * honored. Chrome refuses to load an extension whose CSP weakens `script-src`
 * or `object-src`; here a rejected value degrades to the default, which is the
 * strict answer rather than the permissive one.
 */
const toHeaderValue = (declaration) => {
  if (typeof declaration === "string") {
    const value = declaration.trim();
    return value.length ? value : null;
  }
  if (!declaration || typeof declaration !== "object") {
    return null;
  }
  const value =
    typeof declaration.extension_pages === "string"
      ? declaration.extension_pages.trim()
      : typeof declaration.sandbox_pages === "string"
        ? declaration.sandbox_pages.trim()
        : "";
  return value.length ? value : null;
};

/**
 * @param {object} manifest parsed manifest.json ({} acceptable)
 * @returns {{ value: string, source: "manifest" | "default" }}
 */
const contentSecurityPolicyFor = (manifest) => {
  const fromManifest = toHeaderValue(manifest && manifest.content_security_policy);
  return fromManifest
    ? { value: fromManifest, source: "manifest" }
    : { value: defaultCspFor(manifest), source: "default" };
};

/** Directives a declared policy must not lose, in the sense Chrome intends. */
const REQUIRED_DIRECTIVES = ["script-src", "object-src"];

/**
 * Why a declared policy is weaker than Chrome's, or null when it is not.
 * Chrome will not load such an extension; reporting it beats silently serving a
 * policy this host considers unsafe (docs/features/EXTENSION-MANAGEMENT.md).
 */
const unsafeReason = ({ value }) => {
  const directives = new Set(
    String(value)
      .split(";")
      .map((part) => part.trim().split(/\s+/)[0])
      .filter(Boolean)
  );
  const missing = REQUIRED_DIRECTIVES.filter((name) => !directives.has(name));
  if (missing.length) {
    return `missing ${missing.join(" and ")}`;
  }
  const scriptSrc = /script-src([^;]*)/.exec(String(value)) || [];
  if (/'unsafe-(eval|inline)'|https?:|data:|file:/.test(scriptSrc[1] || "")) {
    return "script-src allows remote or eval'd code";
  }
  return null;
};

module.exports = {
  DEFAULT_EXTENSION_PAGES_CSP,
  REQUIRED_DIRECTIVES,
  contentSecurityPolicyFor,
  defaultCspFor,
  hasServiceWorker,
  unsafeReason,
};
