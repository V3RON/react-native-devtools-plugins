/**
 * Chrome's `FilenameConflictAction`, in the one place both sides of the download
 * channel can read it (the shim in `src/chrome-shim/downloads.js` decides what to report
 * and forward; the handler in `src/main/ipc.js` decides what to hand the save service).
 *
 * The enum, read off the official reference (developer.chrome.com,
 * `downloads#type-FilenameConflictAction`, 2026-10-14):
 *
 *     "uniquify" | "overwrite" | "prompt"
 *
 * `"uniquify"` is Chrome's default and this shell's since GitHub issue #22: a taken name
 * becomes `name (1).ext`. `"overwrite"` is honored only when the caller names it. Neither
 * layer here takes the payload's word for what the value was — an extension's request is
 * untrusted input, and the one thing that must never happen is a value that was never
 * meant as "replace this file" reaching the code that replaces files. So both sides test
 * membership in this set rather than comparing against a spelling, and anything else means
 * "the service's own default", which is the behavior the shim's report promises.
 */

/** The values of Chrome's enum. */
const CHROME_CONFLICT_ACTIONS = new Set(["uniquify", "overwrite", "prompt"]);

/**
 * The values this shell can actually perform, and so the only ones worth forwarding:
 * `prompt` needs a conflict dialog this host does not have.
 */
const PERFORMED_CONFLICT_ACTIONS = new Set(["uniquify", "overwrite"]);

/**
 * The `conflictAction` to put on a save request for a caller's value: the value itself
 * when it is one the save service performs, `undefined` otherwise. `undefined` is the
 * save service's "use your default", which is the same outcome a report above describes.
 */
const conflictActionForRequest = (value) =>
  value !== undefined && PERFORMED_CONFLICT_ACTIONS.has(value) ? value : undefined;

module.exports = {
  CHROME_CONFLICT_ACTIONS,
  PERFORMED_CONFLICT_ACTIONS,
  conflictActionForRequest,
};
