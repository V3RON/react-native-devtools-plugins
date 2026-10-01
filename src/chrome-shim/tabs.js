// chrome.tabs — one synthetic tab for the inspected React Native target, plus the
// tabs this extension asked `create` to open and the host REALLY opened
// (docs/features/SMALL-SHIMS.md, GitHub issue #4).
//
// Why a synthetic tab and not an empty list: `query() -> []` answered "there is no
// tab", which is not a true statement about this host — there is exactly one thing
// being inspected, and in Chrome a devtools extension is looking at a tab of it. The
// consumer that proves the difference is Altair's `assets/tabs.js`: it awaits
// `tabs.create({url: "altair-app/index.html"})`, reads `t.id`, stores it, then does
// `tabs.get(id)` and dereferences `o.url`. With the old inert shell the first step
// resolved `undefined` and the second threw on `.url`. `query`/`get`/`update` now
// answer with the SAME tab, from the same host-reported snapshot, so an extension's
// own id bookkeeping round-trips.
//
// What `create` does NOT do by default is the deliberate decision in this shell:
// `openTab` is absent unless the host's policy enables it (`DEVTOOLS_TABS_OPEN`,
// default `none` — the reasoning is in src/main/config.js and repeated here because
// this is where a reader looks). `shell.openExternal` is Chrome's closest mapping and
// it is fully wired, but both shipped extensions call `create` from an AUTOMATED
// path rather than a user gesture:
//
//   - graphql's `runtime.onInstalled` handler opens a marketing URL;
//   - Altair's `notifications.onClicked` opens `altairgraphql.dev/updated`.
//
// Launching the user's real browser because a devtools session started — or because a
// notification they never clicked was created — is a side effect no extension asked
// this host for. Whatever the policy says, the created descriptor reports the outcome
// truthfully in `openedVia`: "external", "window", or null for nothing opened.
//
// `tabs.sendMessage` stays honest on purpose: there is no content-script context to
// receive it (docs/features/CONTENT-SCRIPTS.md is the next layer, issue #5), so it
// resolves `undefined` with one console line and is NOT routed into this extension's
// own runtime mesh. Wiring it there would let an extension message itself and report
// success as if a page had answered — precisely the thing a devtools extension would
// then trust. Chrome's answer here is a connection failure; that difference is a
// stated deviation, not a claim of success.
const { createEvent } = require("./event");
const { promiseOrCallback } = require("./async-style");
const {
  TAB_ID_NONE,
  UNKNOWN_URL,
  noSuchTab,
  queryMatcher,
  syntheticTab,
} = require("./tab-model");
const { urlMatchesPattern } = require("./web-request");

/** An absolute URL is used as given; anything else is relative to the extension origin. */
const isAbsolute = (url) => /^[a-z][a-z0-9+.-]*:/i.test(String(url));

/**
 * @param {object} deps
 * @param {number} [deps.tabId] the synthetic tab's stable id — the same number
 *        `chrome.devtools.inspectedWindow.tabId` reports (devtools.js `tabIdFor`)
 * @param {() => ({attached?: boolean, url?: string, title?: string}|Promise<object>)} [deps.getTarget]
 *        what the host knows about the inspected target. `attached: false` (or no
 *        injector at all) is the documented constant-fallback condition: url
 *        `about:blank`, title `""`, and no `status`/`windowId` fields.
 * @param {(innerPath: string) => string} [deps.resolveUrl] chrome.runtime.getURL
 * @param {(details: {url: string, windowId?: number, active: boolean}) =>
 *         ({via?: string|null, handle?: any}|Promise<object>)} [deps.openTab] really
 *        open something; absent = the shell's policy is that nothing opens
 * @param {(handle: any) => (boolean|Promise<boolean>)} [deps.closeTab] close what
 *        `openTab` opened, by the handle it reported
 * @param {(message: string) => void} [deps.onUnsupported] honest one-off reports
 * @param {{setError: function, clearError: function}} [deps.lastError] Chrome-scoped
 *        lastError holder, so a failure this model raises ("No tab with id") is
 *        Chrome's failure for a callback caller instead of a silent `undefined`
 */
const createTabs = ({
  tabId = 1,
  getTarget = () => ({ attached: false }),
  resolveUrl = (inner) => String(inner ?? ""),
  openTab = null,
  closeTab = null,
  onUnsupported = () => {},
  lastError = null,
} = {}) => {
  const createdTabs = new Map(); // tabId -> {tab, handle}
  let nextTabId = tabId; // created ids start above the synthetic one
  const matches = queryMatcher((tab) => tab.id === tabId);
  const events = {
    onCreated: createEvent(),
    onRemoved: createEvent(),
    onUpdated: createEvent(),
    onActivated: createEvent(),
    onHighlighted: createEvent(),
    onMoved: createEvent(),
    onAttached: createEvent(),
    onDetached: createEvent(),
  };

  /**
   * The inspected target as a Tab, read live. `url`/`title` only ever come from the
   * host; the fallback pair is Chrome's own "nothing loaded" answer, not a plausible
   * RN URL invented to keep an extension happy.
   */
  const snapshotTarget = async () => {
    const info = (await getTarget()) || {};
    const attached = Boolean(info.attached);
    return syntheticTab({ tabId, attached, url: info.url, title: info.title });
  };

  /** Everything this model can name: the inspected target, then what was created. */
  const allTabs = async () => [
    await snapshotTarget(),
    ...[...createdTabs.values()].map(({ tab }) => ({ ...tab })),
  ];

  /** Chrome's `get`: the inspected tab, a created tab, or Chrome's own failure. */
  const resolveTab = async (id) => {
    // A call with no id answers with the one tab there is. An id this model never
    // handed out fails like Chrome's, rather than answering with a tab the caller
    // did not name.
    if (id === undefined || id === null) {
      return snapshotTarget();
    }
    const asNumber = Number(id);
    if (asNumber === tabId) {
      return snapshotTarget();
    }
    const known = createdTabs.get(asNumber);
    if (known) {
      return { ...known.tab };
    }
    throw noSuchTab(id);
  };

  const createTab = async (createProperties) => {
    const props = createProperties || {};
    const requested =
      props.url === undefined || props.url === null || props.url === ""
        ? UNKNOWN_URL
        : isAbsolute(props.url)
          ? String(props.url)
          : // Chrome resolves a relative `url` against the extension's own origin;
            // so does this, which is what makes Altair's "altair-app/index.html" a
            // real rozenite:// URL an `o.url.includes(id)` check can match.
            resolveUrl(String(props.url));
    const id = ++nextTabId;
    const tab = {
      id,
      url: requested,
      title: "",
      index: 0,
      pinned: false,
      incognito: false,
      discarded: false,
      autoDiscardable: false,
      // Neither `active` nor `windowId` is claimed: a created tab is not the front
      // thing in the inspected window, and it belongs to no window this shell
      // models. `openedVia` is Chrome's field that does not exist, added because
      // "nothing opened" must be observable — see the header.
      openedVia: null,
      ...(props.active === true ? { active: true } : {}),
    };
    // The handle for whatever the host opened, kept out of the Chrome-visible
    // descriptor but remembered so `remove` can actually close the thing.
    let handle;
    if (!openTab) {
      // No capability injected = the host's policy is that nothing opens. Silent,
      // because `openedVia: null` is the answer, and the policy is documented.
    } else if (requested === UNKNOWN_URL) {
      onUnsupported(
        "tabs.create({}) would open an empty tab; this host has nothing to empty-open, so nothing opened."
      );
    } else {
      const outcome = (await openTab({
        url: requested,
        windowId: props.windowId,
        active: props.active !== false,
      })) || {};
      tab.openedVia = typeof outcome.via === "string" && outcome.via ? outcome.via : null;
      handle = outcome.handle;
    }
    createdTabs.set(id, { tab, handle });
    events.onCreated._fire({ ...tab });
    return { ...tab };
  };

  const removeTabs = async (tabIdOrIds) => {
    const ids = Array.isArray(tabIdOrIds) ? tabIdOrIds : [tabIdOrIds];
    const removed = [];
    for (const raw of ids) {
      const id = Number(raw);
      if (id === tabId) {
        // The inspected target is not this extension's tab to close. Chrome would
        // refuse; here it is a resolving no-op with one line, because a worker that
        // closes "its" tab during shutdown must not die on the error instead.
        onUnsupported(
          `tabs.remove(${tabId}) is a no-op: that id is the inspected target, not a tab.`
        );
        continue;
      }
      const known = createdTabs.get(id);
      if (!known) {
        throw noSuchTab(raw);
      }
      createdTabs.delete(id);
      if (closeTab && known.handle !== undefined) {
        await closeTab(known.handle);
      }
      removed.push({ ...known.tab });
    }
    for (const tab of removed) {
      events.onRemoved._fire(tab.id, { windowId: TAB_ID_NONE, isWindowClosing: false });
    }
    // Chrome's callback/promise carries no value.
    return undefined;
  };

  const updateTab = async (requestedId, updateProperties) => {
    const props =
      typeof requestedId === "object" && requestedId !== null
        ? requestedId
        : updateProperties || {};
    const tab = await resolveTab(
      typeof requestedId === "object" && requestedId !== null ? undefined : requestedId
    );
    if (props.url !== undefined) {
      // Chrome navigates. Nothing here has an address bar this shell can drive, so
      // the request is reported and the answer is the tab exactly as it still is.
      onUnsupported(
        `tabs.update: navigating to ${JSON.stringify(String(props.url))} is not possible here ` +
          "(no tab this shell owns has an address bar). Nothing changed."
      );
    }
    if (props.active === true) {
      // Already the active tab, so nothing is activated — and onActivated is NOT
      // fired: an event with no change behind it is a fabrication, not a courtesy.
      onUnsupported(
        "tabs.update: that tab is already the active one, so nothing was activated and onActivated does not fire."
      );
    }
    return tab;
  };

  let sendMessageReported = false;
  const sendTabMessage = async () => {
    if (!sendMessageReported) {
      sendMessageReported = true;
      onUnsupported(
        "tabs.sendMessage has no content-script context to deliver to, so it resolves undefined and " +
          "is NOT routed to this extension's own runtime.onMessage listeners — an extension must not " +
          "be able to message itself and call that a page. Delivery arrives with content scripts " +
          "(docs/features/CONTENT-SCRIPTS.md)."
      );
    }
    return undefined;
  };

  const noValue = (callback) => promiseOrCallback(() => undefined, callback);

  return {
    ...events,
    TAB_ID_NONE,

    query: (queryInfo, callback) => {
      const cb = typeof queryInfo === "function" ? queryInfo : callback;
      const q = typeof queryInfo === "function" ? {} : queryInfo;
      return promiseOrCallback(
        () => allTabs().then((tabs) => tabs.filter((tab) => matches(tab, q, urlMatchesPattern))),
        cb
      );
    },

    get: (tabIdOrCallback, callback) =>
      promiseOrCallback(
        () => resolveTab(typeof tabIdOrCallback === "function" ? undefined : tabIdOrCallback),
        typeof tabIdOrCallback === "function" ? tabIdOrCallback : callback,
        lastError || undefined
      ),

    getCurrent: (callback) => promiseOrCallback(() => snapshotTarget(), callback),

    create: (createProperties, callback) =>
      promiseOrCallback(() => createTab(createProperties), callback),

    // Chrome's three overloads: update(updateProperties), update(tabId, cb) and
    // update(tabId, updateProperties, cb). All of them answer with a Tab.
    update: (first, second, third) => {
      if (typeof first === "function") {
        return promiseOrCallback(() => updateTab(null, {}), first);
      }
      if (typeof second === "function") {
        return promiseOrCallback(() => updateTab(first, {}), second);
      }
      if (typeof first === "object" && first !== null) {
        return promiseOrCallback(() => updateTab(first, {}), second);
      }
      return promiseOrCallback(() => updateTab(first, second || {}), third);
    },

    remove: (tabIdOrIds, callback) =>
      promiseOrCallback(() => removeTabs(tabIdOrIds), callback, lastError || undefined),

    // [HONEST NO-RECEIVERS] resolves undefined, no runtime.lastError — see the
    // header for why that is the honest answer and not Chrome's connection error.
    sendMessage: (...args) =>
      promiseOrCallback(sendTabMessage, args.find((arg) => typeof arg === "function")),

    // Chrome answers with a data URL. A PNG-shaped string here would be a fabricated
    // screenshot, so the answer is undefined: no capture, no image.
    captureVisibleTab: (windowId, options, callback) =>
      noValue([windowId, options, callback].find((arg) => typeof arg === "function")),

    // Not part of chrome.tabs: this shell's own read, for diagnostics and tests, so
    // "what did create actually do" is observable without going through the API.
    _createdTabs: () => [...createdTabs.values()].map(({ tab }) => ({ ...tab })),
    _syntheticTabId: tabId,
  };
};

module.exports = {
  createTabs,
  TAB_ID_NONE,
  UNKNOWN_URL,
  noSuchTab,
  queryMatcher,
  syntheticTab,
};
