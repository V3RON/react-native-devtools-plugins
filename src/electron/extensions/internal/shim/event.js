// Chrome-style Event objects. These are load-bearing beyond storage: extensions
// feature-detect on hasListener/hasListeners, and rely on addListener dedupe +
// removeListener identity semantics (docs/features/RUNTIME-MESSAGING.md,
// cross-cutting contract rules).
const createEvent = () => {
  const listeners = [];

  return {
    addListener: (fn) => {
      if (typeof fn !== "function") {
        throw new TypeError("Listener must be a function");
      }
      // Chrome ignores duplicate registrations of the same function object.
      if (!listeners.includes(fn)) {
        listeners.push(fn);
      }
    },
    removeListener: (fn) => {
      const index = listeners.indexOf(fn);
      if (index !== -1) {
        listeners.splice(index, 1);
      }
    },
    // Chrome: hasListener() with no argument reports "any listener".
    hasListener: (fn) =>
      fn === undefined ? listeners.length > 0 : listeners.includes(fn),
    hasListeners: () => listeners.length > 0,

    // Internal: fire every listener and collect their return values
    // (message listeners signal async responses by returning true).
    // Copy first: Chrome does not deliver the current event to listeners
    // added during its dispatch.
    _fire: (...args) => [...listeners].map((fn) => fn(...args)),
  };
};

module.exports = { createEvent };
