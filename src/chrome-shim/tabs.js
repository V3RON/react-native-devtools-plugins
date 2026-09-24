// chrome.tabs — inert host shell.
//
// There is no browser tab model to inspect: tabs.query answers with an empty
// list, sendMessage/create/update degrade silently, lifecycle events never
// fire. Shape coverage so extensions feature-detect by CALLING instead of
// crashing (docs/OVERVIEW.md stubbing rule; docs/LIMITATIONS.md: Altair's
// tabs.* consumers). Real tab enumeration is out of scope — see
// docs/features/TIER3-OMITTED.md for the browser-controlling class.
const { createEvent } = require("./event");

const callAsync = (cb, ...args) => {
  if (typeof cb === "function") {
    setTimeout(() => cb(...args), 0);
  }
};

const createTabs = () => ({
  query: (queryInfo, cb) => {
    if (typeof queryInfo === "function") cb = queryInfo;
    callAsync(cb, []);
    return Promise.resolve([]);
  },
  get: (tabId, cb) => {
    callAsync(cb, undefined);
    return Promise.resolve(undefined);
  },
  create: (createProperties, cb) => {
    callAsync(cb, undefined);
    return Promise.resolve(undefined);
  },
  update: (tabId, updateProperties, cb) => {
    if (typeof tabId === "object") cb = updateProperties;
    callAsync(cb, undefined);
    return Promise.resolve(undefined);
  },
  remove: (tabId, cb) => callAsync(cb),
  sendMessage: (tabId, message, options, cb) => {
    if (typeof options === "function") cb = options;
    else if (typeof message === "function") cb = message;
    callAsync(cb, undefined); // Chrome: "Could not establish connection."
    return Promise.resolve(undefined);
  },
  captureVisibleTab: (windowId, options, cb) => {
    if (typeof windowId === "object") cb = options;
    callAsync(cb, null);
    return Promise.resolve(null);
  },
  onCreated: createEvent(),
  onRemoved: createEvent(),
  onUpdated: createEvent(),
  onActivated: createEvent(),
  onHighlighted: createEvent(),
  TAB_ID_NONE: -1,
});

module.exports = { createTabs };
