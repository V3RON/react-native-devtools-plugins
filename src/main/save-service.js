// The shell's one save-to-disk path, shared by `chrome.downloads.download` and
// `InspectorFrontendHost.save` (docs/features/SMALL-SHIMS.md, GitHub issue #4;
// docs/api/INSPECTOR-FRONTEND-HOST.md).
//
// Before this, the frontend's `save()` built a Blob, hung an `<a download>` off the
// DevTools document and clicked it — a hack that works only if the renderer is
// allowed to navigate to a `blob:` URL, and that tells nobody (not the extension, not
// the shell) whether anything was written. One implementation in main replaces it:
// pick a path, write the bytes, report the state. `InspectorFrontendHost.save` is now
// a call into this file rather than a second copy of the hack.
//
// What makes the result honest:
//   - a download gets an id only because this file allocated it and is tracking it;
//   - `complete` is reached only after `writeFile` resolved, and `fileSize` is the
//     byte count actually written — not the length of the content asked for;
//   - a failure is `interrupted` with the platform's own message, and the partial file
//     is unlinked, so nothing half-written is reported as a download;
//   - a CANCELLED download is `interrupted` with error `CANCELED`, which is Chrome's
//     own vocabulary, and the file it had written is removed.
//   - `onDeterminingFilename` is only fired at the point where a name is genuinely
//     still to be chosen, and the extension's suggestion is used if it sends one.
//     Nothing waits on an extension that has no listener: the shim answers "no
//     suggestion" synchronously in that case.
//
// Every capability is injected — the save dialog, the fetch, the filesystem, the
// clock, the download directory — so the rules above are unit-tested without Electron
// and without writing outside a temp dir (docs/ARCHITECTURE.md's layering rule).
const DEFAULT_NAME = "download";

/** Chrome's `state` values, spelled as Chrome spells them. */
const STATES = ["in_progress", "interrupted", "complete"];

/** Chrome's own filename-suggestion window: long enough for an extension to answer,
 *  short enough that a listener which claims the callback and stalls cannot hold a
 *  download open. After it, the default name is used and that is reported. */
const SUGGEST_TIMEOUT_MS = 3000;

/** Chrome's error namespace for a cancelled download. */
const CANCELED = "CANCELED";

/**
 * Best-effort filename from a URL, with no network round-trip. Chrome does the same
 * (`byFilename` step): the last path segment, or the host when the path is empty.
 * A plain name that is not a URL (a `body`-only save with no filename) is kept as
 * the name it already is rather than falling back to a generic one.
 */
const nameFromUrl = (url) => {
  const text = String(url ?? "");
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return safeName(text);
  }
  if (parsed.protocol === "data:") {
    // A data URL carries no name. Deriving one from its mime would be a guess about
    // content this file has not looked at, so it gets the generic name.
    return DEFAULT_NAME;
  }
  const last = parsed.pathname.split("/").filter(Boolean).pop();
  return last ? safeName(safeDecode(last)) : safeName(parsed.hostname);
};

const safeDecode = (text) => {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
};

const isDataUrl = (text) => /^data:/i.test(String(text));

/**
 * A data URL's bytes, including Chrome's percent-decoded non-base64 form.
 *
 * Chrome accepts a `data:` URL as a download source and as `downloads.download`'s
 * `data` field, so this shell decodes it rather than sending it to a fetch that has
 * no transport for it. An unsupported encoding is an error with Chrome's wording,
 * never a silently empty file.
 */
const decodeDataUrl = (text) => {
  const match = /^data:([^;,]*)?(;base64)?,(.*)$/is.exec(String(text));
  if (!match) {
    throw new TypeError("downloads: the data URL is malformed.");
  }
  const [, mime, base64, rest] = match;
  if (base64) {
    const decoded = Buffer.from(rest, "base64");
    if (!decoded.length && rest.length) {
      throw new TypeError(`downloads: "${(mime || "data").split("/")[0]}" is not a supported encoding.`);
    }
    return decoded;
  }
  return Buffer.from(safeDecode(rest), "utf8");
};

const safeName = (name, fallback = DEFAULT_NAME) => {
  const text = String(name ?? "").trim();
  if (!text) {
    return fallback;
  }
  // A filename is not a path: strip any directory part and every path separator, so
  // an extension cannot name its way outside the directory the user chose.
  const base = text.split(/[\\/]/).pop().replace(/[:<>|?"*\u0000]/g, "_");
  return base || fallback;
};

/**
 * Chrome's DownloadDelta for one transition. Built here rather than in the shim
 * because this file owns the previous state.
 *
 * A property only appears when it actually CHANGED, and the first delta of a
 * download carries `current` with no `previous` — Chrome's own shape. A delta that
 * reported `state: {previous: 'in_progress', current: 'in_progress'}` would tell an
 * extension a transition happened when none did.
 */
const deltaFor = (previous, record) => {
  const delta = { id: record.id };
  const changed = (key, before, now, addFirstTime = true) => {
    if (!previous) {
      if (addFirstTime && now !== undefined && now !== "" && now !== 0) {
        delta[key] = { current: now };
      }
      return;
    }
    if (before !== now) {
      delta[key] = { previous: before, current: now };
    }
  };
  changed("state", previous ? previous.state : "in_progress", record.state);
  changed("filename", previous ? previous.filename : "", record.filename || "");
  changed("error", previous ? previous.error : "", record.error || "");
  changed("totalBytes", previous ? previous.totalBytes || 0 : 0, record.totalBytes || 0);
  changed("endTime", previous ? previous.endTime || "" : "", record.endTime || "", false);
  return delta;
};

/**
 * @param {object} deps
 * @param {(options: {defaultPath: string, title?: string, filters?: object[]}) =>
 *         (Promise<{canceled?: boolean, filePath?: string}>|{canceled?: boolean, filePath?: string})} deps.showSaveDialog
 * @param {(url: string, signal?: object) => (Promise<{buffer: Buffer, contentType?: string}>|{buffer: Buffer})} deps.fetchUrl
 * @param {(path: string, data: any, options?: object) => Promise<void>} deps.writeFile
 * @param {(path: string) => Promise<void>} [deps.unlink]
 * @param {() => string} deps.downloadsDir where a save without `saveAs` lands
 * @param {(() => string)|string} [deps.now] ISO timestamp
 * @param {{deliver: function}} [deps.contextRegistry] for onChanged / onDeterminingFilename
 * @param {(frameKey: string, delivery: object) => Promise<any>} [deps.askContext] a
 *        request/response round-trip to one context, for the filename suggestion
 * @param {number} [deps.suggestTimeoutMs] how long that suggestion may take
 * @param {(message: string) => void} [deps.log]
 */
const createSaveService = ({
  showSaveDialog,
  fetchUrl,
  writeFile,
  unlink = null,
  downloadsDir,
  now = () => new Date().toISOString(),
  contextRegistry = null,
  askContext = null,
  suggestTimeoutMs = SUGGEST_TIMEOUT_MS,
  log = () => {},
}) => {
  const stamp = () => (typeof now === "function" ? now() : now);
  const records = new Map(); // id -> the download, as this shell knows it
  const pending = new Map(); // id -> {cancel: function}
  let seq = 0;

  // Chrome's download history is per-extension: one extension's `search` never sees
  // another's files. `owner` is the extension id main derived from the CALLING
  // FRAME's URL, and `undefined` means a host-level caller (the DevTools frontend's
  // own save), which is the only caller allowed to see across extensions.
  const visibleTo = (record, owner) => owner === undefined || record.owner === owner;

  const pushChanged = (previous, record) => {
    if (!contextRegistry || !record.frameKey) {
      return;
    }
    contextRegistry.deliver(record.frameKey, {
      kind: "download",
      payload: { event: "changed", delta: deltaFor(previous, record), download: { ...record } },
    });
  };

  const snapshot = (id) => {
    const record = records.get(id);
    if (!record) {
      return null;
    }
    // `frameKey` and `owner` are this shell's routing detail, not part of Chrome's
    // DownloadItem.
    const { frameKey, owner, ...item } = record;
    void frameKey;
    void owner;
    return item;
  };

  /**
   * Ask the creating context for a filename, and only when it can answer.
   *
   * @returns {Promise<{suggestion: string|null, timedOut: boolean, noListener?: boolean}>}
   */
  const askForFilename = async (record) => {
    if (!askContext || !record.frameKey) {
      // Nothing to ask: the name this file derived from the URL stands, and it was
      // not chosen over an unanswered question.
      return { suggestion: null, timedOut: false, noListener: true };
    }
    const answer = await askContext(
      record.frameKey,
      {
        kind: "download",
        payload: {
          event: "determiningFilename",
          download: { ...snapshot(record.id) },
        },
      },
      // The queue owns the deadline: it is what sent the question, and an answer that
      // arrives after it is dropped rather than applied to a decided download.
      { timeoutMs: suggestTimeoutMs }
    ).catch(() => ({ failed: true }));
    if (answer && answer.timedOut) {
      log("chrome.downloads: onDeterminingFilename was never answered, using the derived name");
      return { suggestion: null, timedOut: true };
    }
    if (answer && answer.failed) {
      log("chrome.downloads: asking for a filename suggestion failed, using the derived name");
      return { suggestion: null, timedOut: true };
    }
    return {
      suggestion: answer && answer.suggestion ? answer.suggestion : null,
      timedOut: false,
      noListener: Boolean(answer && answer.noListener),
    };
  };

  /** Where the bytes go: the dialog when `saveAs`, the downloads dir otherwise. */
  const chooseTarget = async (record, suggested) => {
    const name = safeName(suggested || record.requestedFilename || record.suggestedName);
    if (!record.saveAs) {
      const dir = String(downloadsDir()).replace(/[/\\]$/, "");
      return { filePath: `${dir}/${name}`.replace(/\\/g, "/"), name };
    }
    const reply = await showSaveDialog({
      defaultPath: `${String(downloadsDir()).replace(/[/\\]$/, "")}/${name}`,
      title: record.title || "Save file",
    });
    if (!reply || reply.canceled || !reply.filePath) {
      return null;
    }
    return { filePath: reply.filePath, name: safeName(reply.filePath.split(/[\\/]/).pop(), name) };
  };

  const finish = (record, state, extra = {}) => {
    const previous = { ...record };
    record.state = state;
    Object.assign(record, extra);
    if (state === "interrupted" || state === "complete") {
      record.endTime = stamp();
    }
    pending.delete(record.id);
    pushChanged(previous, record);
    return snapshot(record.id);
  };

  const removePartial = async (path) => {
    if (!path || !unlink) {
      return;
    }
    try {
      await unlink(path);
    } catch {
      // A partial file we could not remove is reported as part of the failure note;
      // it is never reported as a completed download.
    }
  };

  /**
   * Start one download/save.
   *
   * @returns {Promise<{ok: true, id: number}|{ok: false, error: string}>} the id is
   *          allocated here and tracked here, which is what makes Chrome's
   *          `download() -> id` honest rather than a number out of thin air.
   */
  const start = async (request) => {
    const {
      frameKey,
      owner,
      url,
      content,
      isBase64,
      filename,
      saveAs,
      title,
    } = request || {};
    if (url === undefined && content === undefined) {
      return { ok: false, error: "downloads.download: either url or body/content is required." };
    }
    if (url !== undefined && typeof url !== "string") {
      return { ok: false, error: "downloads.download: url must be a string." };
    }
    const id = ++seq;
    const record = {
      id,
      frameKey: frameKey || null,
      owner: owner === undefined ? undefined : String(owner),
      url: url === undefined ? null : String(url),
      state: "in_progress",
      startTime: stamp(),
      endTime: "",
      filename: "",
      // Chrome's `byFilename` step: a name the extension did not give is derived from
      // the URL, and the extension may still override it via onDeterminingFilename.
      suggestedName: nameFromUrl(url === undefined ? (filename || DEFAULT_NAME) : url),
      requestedFilename: filename === undefined ? null : safeName(filename, ""),
      saveAs: Boolean(saveAs),
      title: typeof title === "string" ? title : "",
      error: "",
      totalBytes: undefined,
    };
    records.set(id, record);
    let canceled = false;
    pending.set(id, {
      cancel: () => {
        canceled = true;
      },
    });
    pushChanged(null, { ...record });

    try {
      if (!record.requestedFilename) {
        const { suggestion } = await askForFilename(record);
        if (suggestion) {
          const previous = { ...record };
          record.suggestedName = safeName(suggestion);
          pushChanged(previous, record);
        }
      }
      if (canceled) {
        await removePartial(null);
        finish(record, "interrupted", { error: CANCELED, filename: "" });
        return { ok: true, id };
      }

      const target = await chooseTarget(record, record.requestedFilename || null);
      if (!target) {
        // The user said no. Chrome reports an interrupted download with no error,
        // because nothing went wrong.
        finish(record, "interrupted", { filename: "" });
        return { ok: true, id };
      }
      const previous = { ...record };
      record.filename = target.filePath;
      pushChanged(previous, record);

      let payload;
      let encoding;
      if (url !== undefined && isDataUrl(url)) {
        // Chrome downloads a `data:` URL without a network round trip, and so does
        // this shell — a fetch has no transport for it, and failing a save that
        // Chrome performs would be the shell being wrong about its own capability.
        payload = decodeDataUrl(String(url));
      } else if (url !== undefined) {
        const fetched = await fetchUrl(String(url), {
          get aborted() {
            return canceled;
          },
        });
        if (canceled) {
          await removePartial(target.filePath);
          finish(record, "interrupted", { error: CANCELED });
          return { ok: true, id };
        }
        payload = Buffer.isBuffer(fetched.buffer)
          ? fetched.buffer
          : Buffer.from(String(fetched.buffer));
      } else if (isBase64) {
        payload = Buffer.from(String(content), "base64");
      } else if (isDataUrl(content)) {
        // Chrome's `data` field IS a data URL, so it is decoded the way Chrome
        // decodes it — including the percent-decoded, non-base64 form.
        payload = decodeDataUrl(String(content));
      } else {
        payload = String(content ?? "");
        encoding = "utf8";
      }
      await writeFile(target.filePath, payload, encoding ? { encoding } : undefined);
      if (canceled) {
        await removePartial(target.filePath);
        finish(record, "interrupted", { error: CANCELED });
        return { ok: true, id };
      }
      // The byte count that was written, not the one that was asked for.
      const size = Buffer.isBuffer(payload) ? payload.length : Buffer.byteLength(String(payload), "utf8");
      finish(record, "complete", { totalBytes: size });
      return { ok: true, id };
    } catch (error) {
      const message = (error && error.message) || "the save failed";
      await removePartial(record.filename);
      finish(record, "interrupted", { error: message });
      return { ok: true, id };
    }
  };

  /**
   * Chrome's cancel: resolves even for an unknown id, and only an active one changes.
   * Scoped to the caller's extension, so one extension cannot cancel another's
   * download by guessing an id.
   */
  const cancel = async ({ id, owner } = {}) => {
    const entry = pending.get(Number(id));
    const record = records.get(Number(id));
    if (!entry || !record || !visibleTo(record, owner)) {
      return false;
    }
    entry.cancel();
    return true;
  };

  return {
    STATES,
    start,
    cancel,
    /**
     * Chrome's `erase`: forget these ids from this shell's registry. Scoped to the
     * caller's extension, and only finished downloads count — Chrome's erase refuses
     * a running one, and this shell would rather report `{id: []}` than silently
     * forget a download that is still writing.
     */
    erase: ({ ids, owner } = {}) => {
      const erased = [];
      const urls = [];
      const filenames = [];
      for (const raw of ids || []) {
        const id = Number(raw);
        const record = records.get(id);
        if (!record || !visibleTo(record, owner) || record.state === "in_progress") {
          continue;
        }
        records.delete(id);
        // Chrome's EraseResults names what it erased, and this shell knows both.
        erased.push(id);
        urls.push(record.url || "");
        filenames.push(record.filename || "");
      }
      return { id: erased, url: urls, filename: filenames };
    },
    /**
     * Chrome's `search`, answered from what this shell really tracked.
     *
     * The filters implemented here are exactly the ones the shim declares supported
     * (SUPPORTED_QUERY in src/chrome-shim/downloads.js); anything else is IGNORED,
     * and the shim reports that, because a filter silently treated as
     * match-everything is a wrong answer handed back as a right one.
     */
    search: ({ query = {}, owner } = {}) => {
      const q = query || {};
      return [...records.values()]
        .filter((record) => visibleTo(record, owner))
        .filter((record) => {
          if (q.id !== undefined && record.id !== Number(q.id)) {
            return false;
          }
          if (q.state !== undefined && record.state !== q.state) {
            return false;
          }
          if (q.url !== undefined && record.url !== String(q.url)) {
            return false;
          }
          if (q.filename !== undefined && record.filename !== String(q.filename)) {
            return false;
          }
          if (
            q.filenamePrefix !== undefined &&
            !String(record.filename).startsWith(String(q.filenamePrefix))
          ) {
            return false;
          }
          if (q.startedBefore !== undefined && !(record.startTime < String(q.startedBefore))) {
            return false;
          }
          if (q.startedAfter !== undefined && !(record.startTime > String(q.startedAfter))) {
            return false;
          }
          if (q.totalBytesGreater >= 0 && (record.totalBytes || 0) <= q.totalBytesGreater) {
            return false;
          }
          return true;
        })
        .sort((a, b) => b.id - a.id) // newest first, like Chrome's default order
        .slice(0, q.limit === undefined ? undefined : Number(q.limit))
        .map((record) => snapshot(record.id));
    },
    get: ({ id }) => snapshot(Number(id)),
    list: () => [...records.keys()],
    /** The path a completed download wrote, for the caller that must not guess one. */
    pathOf: ({ id }) => {
      const record = records.get(Number(id));
      return record && record.state === "complete" ? record.filename : null;
    },
  };
};

// ── the Electron-backed singleton src/main/ipc.js installs ───────────────────
let instance;

const attachSaveService = (deps = {}) => {
  const { dialog } = require("electron");
  const os = require("os");
  const path = require("path");
  const fs = require("fs/promises");
  const { default: nodeFetch } = require("node-fetch");
  const { getContextRegistry } = require("./context-registry");
  const { getRequestQueue } = require("./context-request");
  const { createSaveService: build } = require("./save-service");

  instance = build({
    showSaveDialog: (options) => dialog.showSaveDialog(options),
    fetchUrl: async (url) => {
      const reply = await nodeFetch(url);
      if (!reply.ok) {
        throw new Error(`${reply.status} ${reply.statusText}`);
      }
      return { buffer: await reply.buffer(), contentType: reply.headers.get("content-type") };
    },
    writeFile: (target, data, options) => fs.writeFile(target, data, options),
    unlink: (target) => fs.unlink(target),
    downloadsDir: () => path.join(os.homedir(), "Downloads"),
    contextRegistry: getContextRegistry(),
    // `chrome.downloads.onDeterminingFilename` needs a request/response round trip,
    // not a push: Chrome pauses the download until the extension answers, and only
    // the context that started the download is allowed to answer.
    askContext: (frameKey, delivery, options) =>
      getRequestQueue().request(frameKey, delivery, options),
    ...deps,
  });
  return instance;
};

const getSaveService = () => instance || attachSaveService();

module.exports = {
  CANCELED,
  DEFAULT_NAME,
  STATES,
  SUGGEST_TIMEOUT_MS,
  createSaveService,
  deltaFor,
  nameFromUrl,
  safeName,
  attachSaveService,
  getSaveService,
};
