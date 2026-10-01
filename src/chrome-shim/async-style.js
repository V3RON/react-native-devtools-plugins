// Chrome's two calling conventions, in one place.
//
// Nearly every async Chrome API answers BOTH ways: promise when no callback is
// passed, callback (and no promise) when one is. Getting this wrong in either
// direction is visible to extensions — a callback-style caller that also gets a
// promise back is harmless, but a promise-style caller handed `undefined` breaks
// `await` (docs/features/RUNTIME-MESSAGING.md's cross-cutting contract rules).
//
// `produce` may return a value or a promise, so the same helper covers a shim whose
// answer is not yet known (permission verdicts, host IPC round-trips).
//
// `options.setError`/`clearError` are for a shim whose own failures are Chrome
// `runtime.lastError` failures: Chrome sets lastError for the duration of the
// callback and hands the callback NO value to work with. Without them a shim would
// either report a failure as a successful `undefined`, or leak a value alongside the
// error. The gate in src/chrome-shim/permission-gate.js does the same thing for
// permission denials; this is the same contract for a shim's own errors.
const promiseOrCallback = (produce, callback, options = {}) => {
  const { setError = null, clearError = () => {} } = options;
  const deliver = (value) => setTimeout(() => callback(value), 0);
  const fail = (error) => {
    if (!setError) {
      setTimeout(() => callback(undefined, { message: error && error.message }), 0);
      return;
    }
    setTimeout(() => {
      try {
        setError(error);
        callback();
      } finally {
        clearError();
      }
    }, 0);
  };

  if (typeof callback !== "function") {
    // Promise style: a rejection is Chrome's rejection, and the caller's `catch`
    // (or the shell's unhandled-rejection reporter) is where it belongs.
    return Promise.resolve().then(produce);
  }

  let started;
  try {
    started = produce();
  } catch (error) {
    fail(error);
    return undefined;
  }
  if (started && typeof started.then === "function") {
    started.then(deliver, fail);
    return undefined;
  }
  deliver(started);
  return undefined;
};

module.exports = { promiseOrCallback };
