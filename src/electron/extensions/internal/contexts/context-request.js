// One host -> context REQUEST, as opposed to a push
// (docs/features/SMALL-SHIMS.md, GitHub issue #4).
//
// `chrome.downloads.onDeterminingFilename` is the reason this exists: Chrome pauses the
// download until the extension answers, so main has to ask a context and WAIT for its
// reply. A push through the context registry cannot carry an answer, and the message
// router is the wrong vehicle (it fans out to every frame of an extension, and the
// answer must come from the one that started the download).
//
// So: main sends a request with a request id over the same `send` closure the registry
// holds, and waits for the matching reply from THAT frame only. The resolve side checks
// the claiming frame against the one that was asked, so a frame cannot answer a request
// it never received; a request nobody answers settles on the caller's timeout, and the
// caller decides what an unanswered question means (the save service keeps the name it
// derived and says that it did).
//
// Pure apart from the injected `deliver`.
const createRequestQueue = ({ deliver }) => {
  const pending = new Map(); // requestId -> {frameKey, resolve, timer}
  let seq = 0;

  /**
   * @param {string} frameKey the ONE context allowed to answer
   * @param {object} delivery what to send it
   * @param {number} [timeoutMs] after which the request settles as {timedOut: true}
   * @param {(value: any) => void} [onTimeout] what an unanswered request resolves to
   */
  const request = (frameKey, delivery, { timeoutMs = 3000, onUnanswered = null } = {}) =>
    new Promise((resolve) => {
      seq += 1;
      const requestId = `req-${seq}`;
      const timer = setTimeout(() => {
        pending.delete(requestId);
        resolve(onUnanswered ? onUnanswered() : { timedOut: true });
      }, timeoutMs);
      pending.set(requestId, { frameKey, resolve, timer });
      const sent = deliver(frameKey, { ...delivery, payload: { ...delivery.payload, requestId } });
      if (!sent) {
        // Nowhere for the question to go: answer it now rather than at the timeout.
        clearTimeout(timer);
        pending.delete(requestId);
        resolve(onUnanswered ? onUnanswered() : { timedOut: true });
      }
    });

  /**
   * The reply, from the frame that was asked.
   *
   * @param {string} claimKey the frame the host sees on the reply's IPC event
   * @returns {boolean} whether a request was actually waiting on that frame
   */
  const resolve = (claimKey, requestId, value) => {
    const entry = pending.get(requestId);
    if (!entry || entry.frameKey !== claimKey) {
      return false;
    }
    clearTimeout(entry.timer);
    pending.delete(requestId);
    entry.resolve(value === undefined ? {} : value);
    return true;
  };

  /** A context that goes away can never answer: settle its requests unanswered. */
  const dropContext = (frameKey, onUnanswered = null) => {
    for (const [requestId, entry] of [...pending]) {
      if (entry.frameKey === frameKey) {
        clearTimeout(entry.timer);
        pending.delete(requestId);
        entry.resolve(onUnanswered ? onUnanswered() : { timedOut: true });
      }
    }
  };

  return {
    request,
    resolve,
    dropContext,
    pending: () => [...pending.keys()],
  };
};

let instance;
const getRequestQueue = () => {
  if (!instance) {
    const { getContextRegistry } = require("./context-registry");
    instance = createRequestQueue({ deliver: (frameKey, delivery) => getContextRegistry().deliver(frameKey, delivery) });
  }
  return instance;
};

module.exports = { createRequestQueue, getRequestQueue };
