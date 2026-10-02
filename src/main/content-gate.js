// The injection gate for content scripts (docs/features/CONTENT-SCRIPTS.md, GitHub
// issue #5). THIS FILE IS WHY NOTHING IS INJECTED BY DEFAULT.
//
// A content script is the one thing in this shell that runs THIRD-PARTY code inside
// the USER'S RUNNING APP — not in a DevTools panel, not in an extension frame, not in
// a window this shell owns. Hermes has no isolated worlds, so there is no sandbox to
// fall back into: an injected script can read and overwrite the app's globals, and a
// hook it installs cannot be undone without restarting the app. That is a heavier act
// than every other capability in this shell, and the host has no UI in which to ask
// the user about it. So the decision is made in configuration, and the default is:
//
//     inject nothing.
//
// ── the opt-in, exactly ───────────────────────────────────────────────────────────
//
//   DEVTOOLS_CONTENT_SCRIPTS   comma/space/newline-separated list of extension ids
//                              (the `extensions/<id>` folder name), and/or the literal
//                              `<all_rn_targets>`. Unset or empty allows NOTHING.
//
//     DEVTOOLS_CONTENT_SCRIPTS=graphql            → only extensions/graphql injects
//     DEVTOOLS_CONTENT_SCRIPTS='<all_rn_targets>' → every extension that declares scripts
//     DEVTOOLS_CONTENT_SCRIPTS=graphql,altair     → both
//
// `<all_rn_targets>` is the conventional token the feature doc asked for. It means
// "every extension in the extensions dir, for the one RN target this shell inspects",
// and nothing more: it is not a wildcard pattern and it matches no URL.
//
// ── why `matches` cannot opt anything in ──────────────────────────────────────────
//
// Chrome keys content scripts on URL patterns. A React Native target has no page URL
// in the sense a pattern is written against — `https://www.graphdev.app/draft?*` has
// no RN analog — so keying on the pattern would mean inventing which RN target each
// pattern "really" meant. This gate therefore NEVER derives permission from a pattern.
// It reports, per entry, that the patterns have no RN analog, and where a pattern
// would have matched the target's own reported URL it says even that — as information,
// not as a decision. The decision comes from the allowlist alone.
//
// ── the manifest dimension, and where this shell is stricter than Chrome ──────────
//
// Chrome injects the `content_scripts` of any extension it will load: there is no
// `content_scripts` permission gating injection, and in MV3 the string
// `"content_scripts"` in `permissions` is an UNKNOWN permission Chrome refuses the
// manifest over. This shell still looks for it, because it is the only in-manifest
// signal an author can send, and reads it as a host-side convention:
//
//   - declared  → the convention is satisfied; still not sufficient without the allowlist;
//   - not declared → allowed to proceed IF the allowlist says so, with the divergence
//                    reported, so nobody reads the absence as an approval.
//
// Both cases are reported. What is NOT true in either case: that this shell behaves
// like Chrome. It is stricter by design, and the strictness is the point.
const { urlMatchesPattern } = require("../chrome-shim/web-request");
const { declaredPermissions } = require("../shared/permissions");

/** The conventional token: every extension, for the one inspected RN target. */
const ALL_RN_TARGETS = "<all_rn_targets>";

/** The manifest permission this host looks for. Chrome has no such gate — see the header. */
const CONTENT_SCRIPTS_PERMISSION = "content_scripts";

const KNOWN_TOKENS = new Set([ALL_RN_TARGETS]);

/**
 * The allowlist, from env or config.
 *
 * @param {string|string[]|null|undefined} raw
 * @returns {{tokens: string[], ids: string[], allRnTargets: boolean, invalid: string[]}}
 */
const parseAllowlist = (raw) => {
  const parts = (Array.isArray(raw) ? raw : String(raw ?? "").split(/[\s,]+/))
    .map((entry) => String(entry ?? "").trim())
    .filter(Boolean);
  const ids = [];
  const invalid = [];
  let allRnTargets = false;
  for (const token of parts) {
    if (token === ALL_RN_TARGETS) {
      allRnTargets = true;
      continue;
    }
    // `<all_urls>` is Chrome's most confident-looking wildcard and it means nothing
    // here. Saying so beats treating it as a malformed id or, worse, as permission.
    if (/^<.*>$/.test(token) && !KNOWN_TOKENS.has(token)) {
      invalid.push(token);
      continue;
    }
    ids.push(token);
  }
  return { tokens: parts, ids, allRnTargets, invalid };
};

/** Parse, or pass through an already-parsed allowlist; anything empty parses to nothing. */
const normalizeAllowlist = (raw) =>
  raw && typeof raw === "object" && !Array.isArray(raw) && "ids" in raw
    ? raw
    : parseAllowlist(raw);

/** Is this extension allowed by this allowlist? Default (empty allowlist): no. */
const isAllowlisted = (allowlist, extensionId) => {
  const list = normalizeAllowlist(allowlist);
  if (list.allRnTargets) {
    return { allowed: true, via: ALL_RN_TARGETS };
  }
  if (list.ids.includes(extensionId)) {
    return { allowed: true, via: extensionId };
  }
  return { allowed: false, via: null };
};

/**
 * `matches` reported against an RN target, as information only.
 *
 * Returns the per-pattern verdicts against the target's OWN reported url (`""` when
 * nothing is attached) and the honest summary: an RN target has no page URL to key
 * on, so no pattern is a match for the purposes of permission.
 */
const reportPatterns = (entry, targetUrl = "") => {
  const patterns = entry.matches || [];
  const notes = [];
  const wouldMatch = [];
  for (const pattern of patterns) {
    let matches = false;
    try {
      matches = Boolean(targetUrl) && urlMatchesPattern(targetUrl, pattern) === true;
    } catch {
      matches = false;
    }
    if (matches) {
      wouldMatch.push(pattern);
    }
  }
  notes.push(
    `matches ${JSON.stringify(patterns)} has no RN analog: URL patterns are not how this ` +
      "host keys content scripts, so they neither allow nor deny injection"
  );
  if (wouldMatch.length > 0) {
    notes.push(
      `(informational) ${JSON.stringify(wouldMatch)} would have matched the inspected ` +
        `target's reported url ${JSON.stringify(targetUrl)} — still not a decision`
    );
  }
  if ((entry.excludeMatches || []).length > 0) {
    notes.push(
      `exclude_matches ${JSON.stringify(entry.excludeMatches)} is not applied either, for the same reason`
    );
  }
  return { notes, wouldMatch };
};

/**
 * The one decision this gate makes.
 *
 * @param {object} params
 * @param {string} params.extensionId
 * @param {object} [params.manifest] the manifest ON DISK (permissions are read here,
 *        never from anything an extension frame or a script says)
 * @param {object} params.entry a normalized `content_scripts` entry
 * @param {object|string|string[]|null} [params.allowlist] DEVTOOLS_CONTENT_SCRIPTS
 * @param {string} [params.targetUrl] the inspected target's reported url, for the
 *        informational pattern report only
 * @returns {{allowed: boolean, code: string, reasons: string[], notes: string[], via: string|null}}
 */
const decideInjection = ({
  extensionId,
  manifest = {},
  entry,
  allowlist = null,
  targetUrl = "",
}) => {
  const list = normalizeAllowlist(allowlist);
  const reasons = [];
  const notes = [];
  const index = entry && entry.index !== undefined ? `[${entry.index}]` : "";

  if (!entry || !Array.isArray(entry.js) || entry.js.length === 0) {
    return {
      allowed: false,
      code: "no-js",
      reasons: [`content_scripts${index}: no "js" to inject`],
      notes,
      via: null,
    };
  }

  const patterns = reportPatterns(entry, targetUrl);
  notes.push(...patterns.notes);

  if (list.invalid.length > 0) {
    notes.push(
      `ignored allowlist token(s) ${JSON.stringify(list.invalid)}: only an extension id or ` +
        `"${ALL_RN_TARGETS}" means anything here`
    );
  }

  const declared = declaredPermissions(manifest);
  const declaresPermission = declared.includes(CONTENT_SCRIPTS_PERMISSION);
  notes.push(
    declaresPermission
      ? `this manifest declares "${CONTENT_SCRIPTS_PERMISSION}" — a ${
          "host-side convention only"
        }: Chrome gates content-script injection on no permission at all, and rejects that ` +
        "string as unknown in an MV3 manifest"
      : `this manifest does not declare "${CONTENT_SCRIPTS_PERMISSION}". Chrome requires no ` +
        "permission for content scripts and MV3 rejects the string, so the absence is not read " +
        "as approval and the presence would not be enough either"
  );
  if (entry.allFrames === true) {
    notes.push(`all_frames is meaningless here: an RN target has no frames`);
  }
  if (entry.matchAboutBlank === true) {
    notes.push(`match_about_blank is meaningless here: there is no about:blank document`);
  }
  if (entry.world === "ISOLATED") {
    notes.push(
      `world "ISOLATED" cannot be honoured: Hermes has no isolated worlds, so this script ` +
        "would run in the app's own main context"
    );
  }
  notes.push(
    `run_at "${entry.runAt}" collapses to "on attach / first context": RN's backend has no ` +
      "Page.addScriptToEvaluateOnNewDocument, so a hook installed here misses code that ran before attach"
  );

  const permit = isAllowlisted(list, extensionId);
  if (!permit.allowed) {
    reasons.push(
      `${extensionId}: not allowlisted. Nothing is injected unless DEVTOOLS_CONTENT_SCRIPTS ` +
        `names "${extensionId}" or "${ALL_RN_TARGETS}" (current: ` +
        `${list.tokens.length > 0 ? JSON.stringify(list.tokens) : "unset — the default, and the safe one"})`
    );
    return { allowed: false, code: "not-allowlisted", reasons, notes, via: null };
  }

  return {
    allowed: true,
    code: "allowlisted",
    reasons: [`${extensionId}: allowlisted via "${permit.via}"`],
    notes,
    via: permit.via,
  };
};

/**
 * Every content-script entry of one extension, decided, with the source-read verdict
 * attached. The point of this function is the REPORT: an extension whose scripts were
 * not injected must be able to say why, in the log, without anyone reading source.
 *
 * @param {object} params see `decideInjection`; `entries` come from the registry scan
 */
const decideEntries = ({ extensionId, manifest = {}, entries = [], allowlist = null, targetUrl = "" }) => {
  const list = normalizeAllowlist(allowlist);
  return entries.map((entry) => ({
    ...entry,
    decision: decideInjection({ extensionId, manifest, entry, allowlist: list, targetUrl }),
  }));
};

module.exports = {
  ALL_RN_TARGETS,
  CONTENT_SCRIPTS_PERMISSION,
  parseAllowlist,
  isAllowlisted,
  reportPatterns,
  decideInjection,
  decideEntries,
};
