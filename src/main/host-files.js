// `InspectorFrontendHost.save` / `append` / `close`: a file the frontend keeps writing
// to (docs/api/INSPECTOR-FRONTEND-HOST.md).
//
// The frontend's FileManager (Console "Save as...", Network "Save all as HAR", Sources
// "Save as...", Performance "Save profile") identifies a file by the `url` string it
// passed to `save`, and resolves/continues on three events the HOST must raise:
//
//   save(url, content, forceSaveAs, isBase64) -> savedURL(url, fileSystemPath)
//                                             or canceledSaveURL(url)
//   append(url, content)                      -> appendedToURL(url)
//   close(url)                                -> nothing
//
// This module is Chrome's `saved_files_` map: after a completed save it remembers the
// path the user chose for that url, a later `save` of the same url re-uses it without
// asking again (unless `forceSaveAs`), and `append` writes only to a path a save of
// that url produced — a url the host never saved to is ignored, so the frontend cannot
// name an arbitrary file to grow. The dialog and the write are the shell's one save
// path (src/main/save-service.js); events go out on the dispatch channel.
//
// A re-save to a remembered path replaces that file, which is what a re-save means, but it
// can no longer damage it: the save service stages the new bytes in its own partial file and
// renames them onto the path only on success (GitHub issue #22). So a re-save that fails —
// mid-write, on a full disk, on a symlink standing at the path — raises `canceledSaveURL` and
// leaves the earlier contents exactly as they were.
//
// Operations on one url run in order (a console log is saved, then appended to in
// chunks, and an append must not overtake the save that gives it a path).

/** A save dialog's default name: the last path segment of the url, else a fallback. */
const nameOf = (url) =>
  String(url).split(/[?#]/)[0].split(/[\\/]/).filter(Boolean).pop() || "untitled.txt";

/**
 * @param {object} deps
 * @param {{start: function, get: function}} deps.saveService src/main/save-service.js
 * @param {(path: string, data: string) => Promise<void>} deps.appendFile
 * @param {(name: string, args: any[]) => boolean} deps.dispatch src/main/dispatch.js
 * @param {(message: string) => void} [deps.log]
 */
const createHostFiles = ({ saveService, appendFile, dispatch, log = () => {} }) => {
  const paths = new Map(); // url -> the path a completed save wrote
  const tails = new Map(); // url -> the promise the next operation on it waits for

  const serial = (url, task) => {
    const run = (tails.get(url) || Promise.resolve()).then(task);
    const tail = run.catch(() => {});
    tails.set(url, tail);
    tail.then(() => {
      if (tails.get(url) === tail) tails.delete(url);
    });
    return run;
  };

  const save = ({ url, content, forceSaveAs, isBase64 } = {}) => {
    if (typeof url !== "string" || !url) {
      return Promise.resolve({ ok: false, error: "save: url must be a non-empty string" });
    }
    return serial(url, async () => {
      const known = paths.get(url);
      const reuse = Boolean(known) && forceSaveAs !== true;
      let outcome;
      try {
        const started = await saveService.start({
          frameKey: null,
          filename: nameOf(url),
          content: typeof content === "string" ? content : String(content ?? ""),
          isBase64: isBase64 === true,
          saveAs: !reuse,
          filePath: reuse ? known : undefined,
        });
        const item = started.ok ? saveService.get({ id: started.id }) : null;
        outcome =
          item && item.state === "complete"
            ? { ok: true, path: item.filename }
            : {
                ok: false,
                canceled: !(item && item.error) && started.ok,
                error: (item && item.error) || started.error || "",
              };
      } catch (error) {
        outcome = { ok: false, canceled: false, error: (error && error.message) || "the save failed" };
      }
      if (outcome.ok) {
        paths.set(url, outcome.path);
        dispatch("savedURL", [url, outcome.path]);
        return outcome;
      }
      // A refused dialog and a failed write both settle the frontend's pending
      // `FileManager.save` promise; only the log tells them apart.
      if (!outcome.canceled) log(`InspectorFrontendHost.save(${nameOf(url)}): ${outcome.error}`);
      dispatch("canceledSaveURL", [url]);
      return outcome;
    });
  };

  const append = ({ url, content } = {}) => {
    if (typeof url !== "string" || !url) {
      return Promise.resolve({ ok: false, error: "append: url must be a non-empty string" });
    }
    return serial(url, async () => {
      const target = paths.get(url);
      if (!target) {
        // Chrome ignores this too: there is no file this host opened for the url.
        log(`InspectorFrontendHost.append(${nameOf(url)}): no saved file for this url, ignored`);
        return { ok: false, error: "no saved file for this url" };
      }
      try {
        await appendFile(target, typeof content === "string" ? content : String(content ?? ""));
      } catch (error) {
        log(`InspectorFrontendHost.append(${nameOf(url)}): ${(error && error.message) || "failed"}`);
        return { ok: false, error: (error && error.message) || "append failed" };
      }
      dispatch("appendedToURL", [url]);
      return { ok: true, path: target };
    });
  };

  const close = ({ url } = {}) => {
    // Ordered behind pending appends, so a close cannot drop the handle under them.
    if (typeof url !== "string") return Promise.resolve({ ok: false });
    return serial(url, async () => {
      paths.delete(url);
      return { ok: true };
    });
  };

  return { save, append, close, pathOf: (url) => paths.get(url) || null };
};

let instance;

const getHostFiles = () => {
  if (!instance) {
    instance = createHostFiles({
      saveService: require("./save-service").getSaveService(),
      appendFile: (target, data) => require("fs/promises").appendFile(target, data, "utf8"),
      dispatch: require("./dispatch").dispatchToFrontend,
      log: (message) => console.warn(`[host-files] ${message}`),
    });
  }
  return instance;
};

module.exports = { createHostFiles, getHostFiles, nameOf };
