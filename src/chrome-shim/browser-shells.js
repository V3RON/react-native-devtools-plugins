// The Tier-2 accept-and-grant shells: `chrome.commands`, `chrome.contextMenus`,
// `chrome.sidePanel`.
//
// These three have one thing in common: the surface Chrome hangs them on does not exist
// in this host. There is no keyboard-shortcut routing to an extension, no browser
// right-click menu to add an item to, and no panel drawer to open a side panel in. Making
// any of them "real" would mean inventing a host feature, which is not this shell's call.
//
// What they MUST do is exist with Chrome's shape and never throw SYNCHRONOUSLY. A worker
// that names `chrome.commands.onCommand.addListener` or `chrome.contextMenus.create` at
// module scope otherwise takes a TypeError at LOAD — an ESM worker's top-level statements
// run before anything can guard them, and the whole background context goes with them
// (docs/OVERVIEW.md's stubbing rule: a no-op degrades, a TypeError kills).
//
// The honesty rule that shapes everything below: accepting a call is a promise about the
// surface, and this shell has no surface. So
//
//   - no event here fires. `onCommand` has no producer because no keystroke is routed to
//     an extension; `contextMenus.onClicked` has no producer because there is no browser
//     menu to click an item in. Firing one would run the handler an extension wrote for a
//     real click — the same reasoning that keeps `action.onClicked` silent;
//   - each namespace says ONCE, through the console, which producer is missing. Silence is
//     the failure mode to avoid: a call that did nothing and said nothing looks exactly
//     like one that worked;
//   - `sidePanel.open` FAILS rather than resolving, because its promise means "the panel is
//     up". Every other accepted call resolves only where the resolve claims nothing beyond
//     "this call was handled"; a resolve standing for a window would be the worse-than-
//     absent case (the same reasoning behind downloads' refused save in
//     src/chrome-shim/downloads.js and runtime.openOptionsPage's refusal);
//   - Chrome's OWN validation is kept, because a rejected call is the extension learning
//     about its own mistake — with Chromium's own message text where Chromium has one
//     ("Cannot create item with duplicate id", "Cannot find menu item with id", "All menu
//     items except for separators must have a title", "At least one of `tabId` and
//     `windowId` must be provided"). An unknown `setPanelBehavior` key is the exception:
//     Chrome refuses it at its schema layer, which this shell cannot reproduce faithfully,
//     so it is reported and ignored rather than rejected — inventing a refusal would break
//     code Chrome accepts;
//   - what the caller configures is RETAINED and readable, so an extension's own
//     bookkeeping is exercised for real: `contextMenus` keeps its registry (a rebuild loop
//     gets honest answers about ids it owns) and `sidePanel` round-trips the options it was
//     handed instead of dropping them. The read-backs are NON-ENUMERABLE (`_`-prefixed):
//     these three APIs are ungated, so the gate's `_`-filter (src/chrome-shim/permission-
//     gate.js) is not in play here and contextBridge would otherwise hand them to the page.
//
// Ungated, like Chrome's: none of these needs a manifest permission, and
// src/shared/permissions.js lists all three under UNGATED_APIS.
const { createEvent } = require("./event");
const { promiseOrCallback } = require("./async-style");

/** One report per key, so an extension in a loop does not flood the console. */
const reporter = (onUnsupported) => {
  const seen = new Set();
  return (key, message) => {
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    onUnsupported(message);
  };
};

/** Shim-side diagnostics that must not cross into the page world. */
const hide = (target, name, value) => {
  Object.defineProperty(target, name, { value, enumerable: false });
  return target;
};

/**
 * Run `produce` in Chrome's dual style, with Chrome's failure style: a thrown error
 * becomes a rejected promise AND `runtime.lastError` for a callback caller, never a
 * synchronous throw (that is what would take a worker down) and never a resolved promise.
 *
 * `argsAndCallback` is the call's own trailing arguments, in order. Chrome's callback is
 * always LAST, and several of these APIs gained optional parameters (a `windowId`) in later
 * Chrome versions, so the callback is found by type rather than by position: an extension
 * calling the older `open(options, callback)` shape must still get a callback answer.
 */
const chromeCall = (deps, produce, ...argsAndCallback) => {
  const callback = [...argsAndCallback].reverse().find((arg) => typeof arg === "function");
  return promiseOrCallback(produce, callback, {
    setError: (error) => {
      deps.lastError.value = error;
    },
    clearError: () => {
      deps.lastError.value = undefined;
    },
  });
};

const lastErrorOf = (lastError) =>
  lastError && typeof lastError === "object" ? lastError : { value: undefined };

/**
 * `chrome.commands` — Chrome dispatches a manifest `commands` entry when the user presses
 * its shortcut. This host routes no shortcut to an extension, so `onCommand` has no
 * producer and never fires.
 *
 * `getAll` is the part that CAN be real: the manifest's `commands` block is a fact both
 * Chrome and this shell read the same way. It hands back the declared name, description,
 * suggested key and `global` flag. It registers nothing, and says so. An extension with no
 * commands gets `undefined`, which is Chrome's answer too.
 *
 * @param {object} deps
 * @param {() => object} [deps.getManifest] live manifest ({} until it loads)
 * @param {(message: string) => void} [deps.onUnsupported]
 * @param {{value: any}} [deps.lastError] the context's shared lastError holder
 */
const createCommands = ({
  getManifest = () => ({}),
  onUnsupported = () => {},
  lastError = null,
} = {}) => {
  const deps = { lastError: lastErrorOf(lastError) };
  const report = reporter(onUnsupported);

  return hide(
    {
      onCommand: createEvent(),

      getAll: (callback) =>
        chromeCall(deps, () => {
          const declared = (getManifest() || {}).commands;
          if (!declared || typeof declared !== "object" || !Object.keys(declared).length) {
            // Chrome's answer for an extension that declares no commands.
            return undefined;
          }
          const commands = Object.fromEntries(
            Object.entries(declared).map(([name, entry]) => {
              const spec = entry && typeof entry === "object" ? entry : {};
              // Chrome's `shortcuts` is the platform-resolved list. This shell reports the
              // declared default, because that is what the manifest actually says; resolving
              // it per-platform and registering the result are the two things it cannot do.
              const suggested = spec.suggested_key;
              const shortcut =
                typeof suggested === "string"
                  ? suggested
                  : suggested && typeof suggested === "object"
                    ? suggested.default
                    : undefined;
              return [
                name,
                {
                  name,
                  description: typeof spec.description === "string" ? spec.description : "",
                  shortcuts: shortcut ? [String(shortcut)] : [],
                  global: Boolean(spec.global),
                },
              ];
            })
          );
          report(
            "no-shortcut-routing",
            "chrome.commands: this host routes no keyboard shortcut to an extension, so the " +
              `${Object.keys(commands).length} declared command(s) are reported by getAll but ` +
              "commands.onCommand will never fire for them."
          );
          return commands;
        }, callback),
    },
    // Diagnostics only: which declared commands this shell saw but cannot dispatch.
    "_declaredNames",
    () => Object.keys((getManifest() || {}).commands || {})
  );
};

/**
 * Chrome's ContextType enum (chrome/common/extensions/api/context_menus.json). A
 * `contexts` entry naming anything else is refused by Chrome's schema binding before the
 * API ever runs, so it is refused here too.
 */
const CONTEXT_TYPES = [
  "all",
  "audio",
  "browser_action",
  "contextmenu",
  "editable",
  "frame",
  "image",
  "link",
  "page",
  "page_action",
  "selection",
  "video",
];

/** Chrome's ItemType enum; `create`/`update` accept one of these or nothing. */
const ITEM_TYPES = ["normal", "checkbox", "radio", "separator"];

/**
 * `chrome.contextMenus` — Chrome adds items to a browser right-click menu. There is no
 * browser here, so nothing is ever shown and `onClicked` has no producer.
 *
 * The menu is still modelled as a registry, so `update`/`remove`/`removeAll` operate on
 * state an extension really owns rather than asserting success over nothing. The model has
 * no view; that is the divergence, and it is announced on the first `create`.
 *
 * @param {object} deps
 * @param {(message: string) => void} [deps.onUnsupported]
 * @param {{value: any}} [deps.lastError] the context's shared lastError holder
 */
const createContextMenus = ({ onUnsupported = () => {}, lastError = null } = {}) => {
  const deps = { lastError: lastErrorOf(lastError) };
  const report = reporter(onUnsupported);
  const items = new Map(); // id -> the Properties that were registered
  let generated = 0;

  const keyOf = (idOrInfo) =>
    idOrInfo === undefined || idOrInfo === null
      ? ""
      : typeof idOrInfo === "object"
        ? String(idOrInfo.id ?? "")
        : String(idOrInfo);

  return hide(
    {
      onClicked: createEvent(),
      onVisited: createEvent(),
      // Chrome's constants, spelled as Chrome spells them: extensions build against them.
      ContextType: Object.fromEntries(CONTEXT_TYPES.map((value) => [value, value])),
      ItemType: Object.fromEntries(ITEM_TYPES.map((value) => [value, value])),
      // Chrome's own constant, so a menu builder can read the limit it enforces.
      ACTION_MENU_TOP_LEVEL_LIMIT: 6,

      create: (createProperties, callback) =>
        chromeCall(deps, () => {
          const props = createProperties || {};
          if (props.title !== undefined && typeof props.title !== "string") {
            throw new Error("chrome.contextMenus.create: title must be a string.");
          }
          if (
            props.contexts !== undefined &&
            (!Array.isArray(props.contexts) ||
              props.contexts.some((context) => !CONTEXT_TYPES.includes(String(context))))
          ) {
            throw new Error(
              `Invalid value for contexts. Values must be of type ContextType ` +
                `(one of: ${CONTEXT_TYPES.join(", ")}).`
            );
          }
          if (
            props.type !== undefined &&
            props.type !== null &&
            !ITEM_TYPES.includes(String(props.type))
          ) {
            throw new Error(
              `Invalid value for type. Values must be of type ItemType ` +
                `(one of: ${ITEM_TYPES.join(", ")}).`
            );
          }
          const key =
            typeof props.id === "string" && props.id
              ? props.id
              : `rozenite-generated-${generated++}`;
          if (items.has(key)) {
            // Chrome's own rejection. Merging quietly would leave the extension configuring
            // an item whose properties are a blend of two calls.
            throw new Error(`Cannot create item with duplicate id ${key}`);
          }
          if (typeof props.title !== "string" && props.type !== "separator") {
            throw new Error("All menu items except for separators must have a title");
          }
          items.set(key, { ...props });
          report(
            "no-menu",
            "chrome.contextMenus: this host has no browser right-click menu, so registered items " +
              "are never shown and contextMenus.onClicked will never fire for them."
          );
          // Chrome's callback takes no value and its promise resolves with the id. The id is
          // the honest half of that: it is the key this registry really filed under.
          return key;
        }, callback),

      update: (idOrInfo, updateProperties, callback) =>
        chromeCall(deps, () => {
          const key = keyOf(idOrInfo);
          const props =
            typeof idOrInfo === "object" && idOrInfo ? idOrInfo : updateProperties || {};
          const existing = items.get(key);
          if (!existing) {
            // Chrome's own message. Answering success would tell an extension its item was
            // updated when its own bookkeeping is what is wrong.
            throw new Error(`Cannot find menu item with id ${key}`);
          }
          items.set(key, { ...existing, ...props });
          return undefined;
        }, callback),

      remove: (menuItemId, callback) =>
        chromeCall(deps, () => {
          const key = keyOf(menuItemId);
          if (!items.delete(key)) {
            // Chrome rejects this too, so the extension and the shell cannot disagree about
            // what exists without the extension hearing about it.
            throw new Error(`Cannot find menu item with id ${key}`);
          }
          return undefined;
        }, callback),

      removeAll: (callback) =>
        chromeCall(deps, () => {
          items.clear();
          return undefined;
        }, callback),
    },
    // Diagnostics/tests only: the registry's own ids, for asserting a rebuild loop works.
    "_itemIds",
    () => [...items.keys()]
  );
};

/** Chrome's `setOptions` does not report the scope key back among stored options. */
const without = (object, ...keys) =>
  Object.fromEntries(Object.entries(object || {}).filter(([key]) => !keys.includes(key)));

/**
 * `chrome.sidePanel` — Chrome docks an extension page in a toolbar drawer. This shell has
 * no drawer.
 *
 * What IS honoured is the caller's own configuration: `setOptions` stores what it was
 * handed and `getOptions` returns exactly that, because that is state the extension owns
 * and a round-trip is checkable. `open` is the opposite case — its promise means "the panel
 * is up" — so it fails, the way downloads' refused save fails.
 *
 * @param {object} deps
 * @param {(message: string) => void} [deps.onUnsupported]
 * @param {{value: any}} [deps.lastError] the context's shared lastError holder
 */
const createSidePanel = ({ onUnsupported = () => {}, lastError = null } = {}) => {
  const deps = { lastError: lastErrorOf(lastError) };
  const report = reporter(onUnsupported);
  const perPath = new Map(); // path -> the path-specific options Chrome keeps separately
  let windowOptions = {};
  let behavior = {};

  const missingSurface = (what, consequence) =>
    report(
      `no-panel:${what}`,
      `chrome.sidePanel.${what}: this host has no side-panel drawer, so ${consequence}`
    );

  return hide(
    {
      // Chrome added onClicked for the toolbar icon; there is no toolbar icon here.
      onClicked: createEvent(),

      setOptions: (options, windowId, callback) =>
        chromeCall(deps, () => {
          const opts = options && typeof options === "object" ? options : {};
          const path = typeof opts.path === "string" && opts.path ? opts.path : null;
          if (path) {
            perPath.set(path, { ...(perPath.get(path) || {}), ...without(opts, "path") });
          } else {
            windowOptions = { ...windowOptions, ...without(opts, "path") };
          }
          missingSurface(
            "setOptions",
            "the configuration is kept and reads back through getOptions, but no panel will " +
              "ever appear for it."
          );
          return undefined;
        }, windowId, callback),

      getOptions: (options, windowId, callback) =>
        chromeCall(deps, () => {
          const path =
            options && typeof options === "object" && typeof options.path === "string"
              ? options.path
              : null;
          if (path) {
            return { ...(perPath.get(path) || {}), path };
          }
          // What was set, and nothing more: Chrome's default is `enabled: true`, and
          // claiming that default here would report a panel state this host does not have.
          return { ...windowOptions };
        }, windowId, callback),

      open: (options, windowId, callback) =>
        chromeCall(deps, () => {
          const opts = options && typeof options === "object" ? options : {};
          if (opts.tabId === undefined && opts.windowId === undefined) {
            // Chrome's own rejection: this is a real bug in the caller.
            throw new Error("At least one of `tabId` and `windowId` must be provided");
          }
          missingSurface(
            "open",
            "there is nothing to open: the call fails rather than resolving, because its " +
              "promise would otherwise stand for a panel that is up."
          );
          throw new Error(
            "chrome.sidePanel.open: this host has no side-panel drawer, so there is nothing to open."
          );
        }, windowId, callback),

      setPanelBehavior: (behaviorOrWindowId, maybeBehavior, callback) =>
        chromeCall(deps, () => {
          const value =
            behaviorOrWindowId && typeof behaviorOrWindowId === "object"
              ? behaviorOrWindowId
              : maybeBehavior;
          const accepted = ["openPanelOnActionClick"];
          for (const key of Object.keys(value || {})) {
            if (!accepted.includes(key)) {
              report(
                `behavior:${key}`,
                `chrome.sidePanel.setPanelBehavior: "${key}" is not a Chrome PanelBehavior key, ` +
                  "so this shell ignores it. Chrome's schema rejects it."
              );
            }
          }
          behavior = {
            ...behavior,
            ...Object.fromEntries(
              Object.entries(value || {}).filter(([key]) => accepted.includes(key))
            ),
          };
          missingSurface(
            "setPanelBehavior",
            "the behaviour is kept and reads back through getPanelBehavior, but there is no " +
              "toolbar click here to act on it."
          );
          return undefined;
        }, maybeBehavior, callback),

      getPanelBehavior: (windowIdOrCallback, callback) =>
        chromeCall(deps, () => ({ ...behavior }), windowIdOrCallback, callback),
    },
    // Diagnostics/tests only.
    "_state",
    () => ({
      behavior: { ...behavior },
      paths: [...perPath.keys()],
      windowOptions: { ...windowOptions },
    })
  );
};

module.exports = {
  CONTEXT_TYPES,
  ITEM_TYPES,
  createCommands,
  createContextMenus,
  createSidePanel,
};
