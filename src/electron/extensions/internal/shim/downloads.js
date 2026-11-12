// `chrome.downloads` — Chrome's API over the shell's one save path
// (src/main/save-service.js; docs/features/SMALL-SHIMS.md, GitHub issue #4).
//
// The shim's job is the Chrome-shaped surface plus the honesty rule; every byte
// decision is the save service's, in main, where the filesystem actually is.
//
//   - `download()` resolves the id main allocated. If main refused, the call fails with
//     main's reason — no id is invented, so nothing can later be "found" that was never
//     written.
//   - `onChanged` is pushed by main for the transitions that really happened, into the
//     context that started the download (Chrome's rule, and the reason main tracks a
//     frame key per download).
//   - `onDeterminingFilename` keeps Chrome's two-step contract, including the part
//     extensions depend on: WITH NO LISTENER REGISTERED the download proceeds with the
//     suggested name. This shim answers that case immediately instead of letting the
//     host wait out its timeout for a callback that was never going to come.
//   - `cancel`/`erase`/`search` report main's answer, so the shell never claims a file
//     exists that it did not write.
//
// Not implemented, and not faked: `danger`/`warning` UI, `conflictAction` other than
// overwriting, and `show`/`showDefaultFolder` (there is no download shelf to reveal
// anything in). Each of those is reported the first time it is asked for, because a
// call that silently did nothing reads as one that worked.
const { createEvent } = require("./event");
const { promiseOrCallback } = require("./async-style");

/**
 * Chrome's DownloadQuery fields this shell's host can actually filter on
 * (src/main/save-service.js implements exactly this list). Anything else is
 * ignored, and reported as ignored — see `search` below.
 */
const SUPPORTED_QUERY = new Set([
  "id",
  "state",
  "url",
  "filename",
  "filenamePrefix",
  "startedBefore",
  "startedAfter",
  "totalBytesGreater",
  "limit",
]);

/**
 * @param {object} deps
 * @param {(request: object) => (Promise<{ok: boolean, id?: number, error?: string}>|object)} [deps.start]
 * @param {(id: number) => (Promise<boolean>|boolean)} [deps.cancel]
 * @param {(ids: number[]) => (Promise<number[]>|number[])} [deps.erase]
 * @param {(query: object) => (Promise<object[]>|object[])} [deps.search]
 * @param {(message: string) => void} [deps.onUnsupported]
 * @param {(requestId: string, suggestion: string|null) => void} [deps.respondSuggestion]
 *        hands main the extension's filename suggestion for one pending
 *        `onDeterminingFilename` request (main holds the save until it arrives or its
 *        timeout passes — it never guesses a name over an unanswered question)
 */
const createDownloads = ({
  start = null,
  cancel = null,
  erase = null,
  search = null,
  onUnsupported = () => {},
  respondSuggestion = () => {},
}) => {
  const onChanged = createEvent();
  const onDeterminingFilename = createEvent();
  const reported = new Set();
  const report = (key, message) => {
    if (reported.has(key)) {
      return;
    }
    reported.add(key);
    onUnsupported(message);
  };

  /**
   * main -> this context: one download event. Returns whether it was consumed, so the
   * frame's delivery router can fall through to runtime messaging for anything else.
   */
  const onDelivery = (delivery) => {
    if (!delivery || delivery.kind !== "download") {
      return false;
    }
    const payload = delivery.payload || {};
    if (payload.event === "changed" && payload.delta) {
      onChanged._fire(payload.delta, payload.download);
      return true;
    }
    if (payload.event === "determiningFilename") {
      if (!onDeterminingFilename.hasListeners()) {
        // Chrome's rule, answered at once rather than at the end of main's timeout.
        respondSuggestion(payload.requestId, null);
        return true;
      }
      let answered = false;
      const answer = (suggestion) => {
        if (answered) {
          return; // Chrome: the callback may be invoked once
        }
        answered = true;
        respondSuggestion(payload.requestId, typeof suggestion === "string" ? suggestion : null);
      };
      // Chrome's contract: the extension MUST call the callback, and nothing is
      // decided until it does. So there is no auto-answer here — a listener that
      // suggests a name asynchronously (the common case: it asks the user) would be
      // pre-empted by one. Main waits, and answers with the default name when its own
      // timeout expires, reporting that it did.
      onDeterminingFilename._fire(payload.download, (suggestion) => answer(suggestion));
      return true;
    }
    return false;
  };

  const noBackendError = () => {
    report("no-backend", "chrome.downloads has no save backend in this context: nothing was written.");
    return new Error("chrome.downloads.download: no save backend in this context.");
  };

  return {
    onDeterminingFilename,
    onChanged,

    download: (options, callback) =>
      promiseOrCallback(async () => {
        const opts = options || {};
        if (!start) {
          throw noBackendError();
        }
        if (opts.conflictAction !== undefined && opts.conflictAction !== "unique") {
          // Chrome's own values are `unique` (its default), `overwrite` and `prompt`;
          // this shell overwrites, so anything else is reported rather than ignored.
          report(
            `conflict:${opts.conflictAction}`,
            `chrome.downloads: conflictAction "${opts.conflictAction}" is not implemented — an ` +
              "existing file at the chosen path is overwritten."
          );
        }
        // No report for `saveAs` unset: Chrome writes those into its downloads folder
        // without asking either, so doing the same is conformance, not a divergence.
        if (opts.method !== undefined) {
          report(
            "method",
            "chrome.downloads: `method` is ignored — this shell fetches with GET, and a `body` is " +
              "written as the file's content rather than POSTed."
          );
        }
        const reply = await start({
          url: opts.url,
          // Chrome's `body` is POST data. This shell has no POST-download path, so the
          // body becomes the file's content — which is what a data-URL save means here,
          // and it is reported rather than quietly reinterpreted.
          content: opts.body !== undefined ? opts.body : opts.data,
          filename: opts.filename,
          saveAs: opts.saveAs === true,
          title: opts.title,
        });
        if (!reply || !reply.ok) {
          throw new Error((reply && reply.error) || "chrome.downloads.download: the save was refused.");
        }
        return reply.id;
      }, callback),

    // Chrome's DownloadQuery, answered from what this shell really tracked. An empty
    // list means this shell has not written anything, which is the truth rather than
    // "downloads are not supported".
    //
    // A query key the host cannot answer is IGNORED, which can return a task Chrome
    // would have filtered out — so it is reported once, rather than leaving a "no
    // matches" or "these match" answer that reads as if the filter had been applied.
    search: (query, callback) =>
      promiseOrCallback(async () => {
        if (!search) {
          return [];
        }
        const unsupported = Object.keys(query || {}).filter((key) => !SUPPORTED_QUERY.has(key));
        for (const key of unsupported) {
          report(
            `query:${key}`,
            `chrome.downloads.search: the query field "${key}" is not implemented and was ignored — ` +
              "results may include downloads this filter would have excluded."
          );
        }
        return (await search(query || {})) || [];
      }, callback),

    cancel: (downloadId, callback) =>
      promiseOrCallback(async () => Boolean(cancel && (await cancel(downloadId))), callback),

    // Chrome's erase removes entries from the browser's history; this shell's registry
    // is the equivalent. The FILE is not deleted — Chrome does not delete it either.
    // The `{id, url, filename}` answer is the host's, since the host is what knows
    // which urls and filenames those ids were.
    erase: (query, callback) =>
      promiseOrCallback(async () => {
        if (!erase || !query || !Array.isArray(query.ids)) {
          return { id: [], url: [], filename: [] };
        }
        const reply = await erase(query.ids);
        if (!reply || Array.isArray(reply)) {
          return { id: reply || [], url: [], filename: [] };
        }
        return { id: reply.id || [], url: reply.url || [], filename: reply.filename || [] };
      }, callback),

    // No download shelf and no browser UI: there is nowhere to reveal a file.
    show: (downloadId, callback) => {
      report(
        "show",
        "chrome.downloads.show does nothing: this host has no download shelf to reveal a file in."
      );
      return promiseOrCallback(
        () => undefined,
        typeof downloadId === "function" ? downloadId : callback
      );
    },
    showDefaultFolder: (callback) => {
      report("showDefaultFolder", "chrome.downloads.showDefaultFolder does nothing: no download shelf exists.");
      return promiseOrCallback(() => undefined, callback);
    },

    // NOT part of chrome.downloads: the shim's own hooks (`_`-prefixed, so the
    // permission gate keeps them out of the exposed namespace).
    _onDelivery: onDelivery,
  };
};

module.exports = { createDownloads };
