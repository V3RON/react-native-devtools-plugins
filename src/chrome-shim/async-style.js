// Chrome's two calling conventions, in one place.
//
// Nearly every async Chrome API answers BOTH ways: promise when no callback is
// passed, callback (and no promise) when one is. Getting this wrong in either
// direction is visible to extensions — a callback-style caller that also gets a
// promise back is fine, but a promise-style caller handed `undefined` breaks
// `await` (docs/features/RUNTIME-MESSAGING.md's cross-cutting contract rules).
//
// `produce` may return a value or a promise, so the same helper covers a shim
// whose answer is not yet known (permission verdicts, host IPC round-trips).
const promiseOrCallback = (produce, callback) => {
  if (typeof callback !== "function") {
    return Promise.resolve().then(produce);
  }
  let result;
  try {
    result = produce();
  } catch (error) {
    // A throwing producer must not become an unhandled rejection for a
    // callback-style caller: Chrome reports failures through lastError.
    setTimeout(() => callback(undefined, { message: error && error.message }), 0);
    return undefined;
  }
  if (result && typeof result.then === "function") {
    result.then(
      (value) => setTimeout(() => callback(value), 0),
      (error) => setTimeout(() => callback(undefined, { message: error && error.message }), 0)
    );
    return undefined;
  }
  setTimeout(() => callback(result), 0);
  return undefined;
};

module.exports = { promiseOrCallback };
