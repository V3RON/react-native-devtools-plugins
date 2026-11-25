# Limitations of the current prototype

**Extension model**

- No extension lifecycle UI: no install/uninstall/reload or permissions prompt. Manifest
  parsing + enumeration are the shell's job now (`src/electron/extensions/internal/registry/extensions.js` scans
  `extensions/` for devtools pages **and** backgrounds and hosts both — see
  [features/DEVTOOLS-PANELS.md](features/DEVTOOLS-PANELS.md) and
  [features/BACKGROUND-WORKER.md](features/BACKGROUND-WORKER.md)), so the frontend needs no
  hardcoded extension list. Dropping a folder in `extensions/` and (re)loading the
  frontend installs an extension; there is no watcher or UI.
- **Background service workers run now** — as an always-on hidden `BrowserWindow` per
  extension, against the same `chrome.*` shim, with `runtime.onInstalled`/`onStartup` firing
  and the worker as an ordinary messaging peer (`src/electron/extensions/internal/contexts/background-host.js`,
  [features/BACKGROUND-WORKER.md](features/BACKGROUND-WORKER.md)). Proven headless in a real
  Electron process, including against the shipped `graphql` and `altair` folders. What this
  is **not**: it is not Chrome's MV3 lifecycle — nothing evicts the worker when idle and
  nothing has to wake it, so `onSuspend`/`onUpdateAvailable` never fire and a worker that
  would have been torn down in Chrome keeps running here. That is a superset for a devtools
  host and a divergence from Chrome's resource model at the same time.
- Still missing from the extension model: a working `action`/popup — 🚷 **decision recorded, not
  planned**: this host has no toolbar, so `action.onClicked` has no producer by construction and
  never will. `commands.onCommand` and `contextMenus.onClicked` are registrable; only the first
  is fixable here (the Electron app menu can route a shortcut), while the second is 🚷 — the menu
  it attaches to is the page's, and there is no page. Content-script injection has
  arrived since (issue #5, [features/CONTENT-SCRIPTS.md](features/CONTENT-SCRIPTS.md)), but only
  for an extension a developer names in `DEVTOOLS_CONTENT_SCRIPTS`, and only into the app's own
  JS context — Hermes has no isolated worlds, so a script there can read and overwrite app
  globals. A library that looks for its DevTools hook once, at load (mobx, Redux's
  `configureStore`, relay-runtime's `Environment`), needs the hook installed before its
  module runs, which only the bundler can do: dev-only, through
  `src/electron/extensions/early-main-world.js` as a Metro polyfill (`app/metro.config.js`).
  The browser surface content scripts assume (`document`, `location`, `navigator`, events,
  `MessageChannel`) is answered per extension from its scope, never on the app's global, and
  is a thin stand-in: no layout, no real DOM, `location` is `about:blank`
  ([features/CONTENT-SCRIPTS.md](features/CONTENT-SCRIPTS.md)). Observed on a real device; the message-loss gap that run found is fixed and
  re-observed there, so a send nobody could receive now fails with Chrome's own connection
  error instead of looking answered. What HAS arrived since (issue #4,
  [features/SMALL-SHIMS.md](features/SMALL-SHIMS.md)): `notifications` raises real system
  notifications, `alarms` runs real timers, `downloads` really saves over the shell's one
  export path, manifest `options_ui` opens a real window, `permissions` reports the manifest's
  truth, and `tabs` answers with one synthetic tab for the inspected target rather than an
  empty list. A `chrome.permissions` prompt still does not exist, so `permissions.request`
  grants nothing. **`chrome.windows` is not injected at all** — no window model exists to
  report — so a worker naming it at module scope is the one remaining case where Tier 2
  breaks the "a missing namespace must not kill the worker" rule. Real `chrome.windows`
  behavior is 🚷 (no window model); the *inert shell* that satisfies the rule is a small
  open item.
- DevTools pages are only "loaded" as iframes; no real separation between devtools page
  and panel frames like Chrome has.

**API fidelity**

- `chrome.webRequest` is **observe-only**: seven of Chrome's nine events come from the
  shell's own CDP `Network.*` model with real filters and `ResourceType`, but listeners can
  never block/modify/cancel a request — RN implements no CDP `Fetch` domain (🚷: the backend
  has no such domain, so this is not something we can implement here). `addListener`
  with `["blocking"]` registers and logs one honest note. `onHeadersReceived` and
  `onAuthRequired` have no CDP counterpart and never fire
  ([features/WEBREQUEST.md](features/WEBREQUEST.md)).
- Network data only exists **if the inspected app reports it**. `Network.enable` is refused
  when the app registers more than one RN host (`HostAgent.cpp:150`) and the whole domain
  can be compiled out (`InspectorFlags.cpp:44`); traffic that bypasses the inspected
  runtime's network stack is invisible either way. The correct failure mode is implemented
  and tested — an empty list plus `getNetworkStatus()` naming the backend's own reason —
  but it has not been exercised against a device from this checkout
  ([features/DEVTOOLS-NETWORK.md](features/DEVTOOLS-NETWORK.md)).
- Network history is a bounded ring (500 settled records, in-flight requests never dropped);
  an evicted record's body then honestly reports itself as unavailable rather than stale.
- `chrome.i18n` is real and Chromium-checked (the recorded cases are replayed in
  `tests/i18n-chromium-parity.test.js`), but: `detectLanguage` never detects (no CLD3 —
  `{isReliable: false, languages: []}`), `getAcceptLanguages` is derived from the UI/OS
  languages rather than profile prefs, a `_locales/fr_CA` folder is not consulted for
  fr-CA (only the resolved locale is known), and catalogs Chrome would refuse to load are
  loaded leniently with a log line. The first `getMessage` costs one synchronous
  `XMLHttpRequest` to the frame's own `rozenite://` origin — the one synchronous read a
  frame makes, deliberately not IPC ([features/STORAGE-AND-I18N.md](features/STORAGE-AND-I18N.md)).
- `chrome.tabs` answers with **one synthetic tab standing for the inspected RN
  target** (`src/electron/extensions/internal/shim/tabs.js`, [features/SMALL-SHIMS.md](features/SMALL-SHIMS.md)).
  `query`/`get`/`update` all return that same tab under the id
  `devtools.inspectedWindow.tabId` reports; its `url`/`title` come from `Target.getTargetInfo`
  while a CDP session is attached, and fall back to Chrome's own `about:blank` + `""` when it
  is not — with `status` and `windowId` left absent rather than guessed. That is **one tab
  standing in for a whole browser**: there is no tab strip, no window model, and no second
  tab, so a `windowId`/`groupId`/`title` query filter matches nothing by design.
- **A content script cannot message a DIFFERENT extension.** Chrome allows
  `runtime.sendMessage(extensionId, …)` / `connect(extensionId, …)` when the target declares
  `externally_connectable`. Here a foreign target id is refused with Chrome's own connection
  failure, naming the extension that was being asked — because that grant matches a **page
  origin** against the target's declared `matches`, and an RN target has no URL to match, so
  the grant has nothing to evaluate against. Addressing your own extension id still works.
  Refusing is also the alternative to the failure this replaced: the loader used to *drop*
  the target id, so the message reached the **sender's own** worker and panels, and an answer
  from them looked exactly like the addressee replying.
- **`chrome.tabs.sendMessage` delivers only to a script that was opted in.** Its receiver is
  this extension's own content script inside the inspected app
  ([features/CONTENT-SCRIPTS.md](features/CONTENT-SCRIPTS.md), issue #5), and no script is
  injected unless `DEVTOOLS_CONTENT_SCRIPTS` names the extension — so by default this call
  **fails**, with the reason (`no content script of "…" is running in the inspected target`)
  as a rejected promise and `runtime.lastError`. It is never routed into the caller's own
  `runtime.onMessage`: an extension answering itself and calling that a page is the false
  positive this host refuses on principle. Where it differs from Chrome is *which* messages
  arrive at all — Chrome injects what a manifest declares, this shell injects what a
  developer has explicitly allowed.
- **`chrome.tabs.create` opens nothing by default.** It returns a real descriptor (id +
  resolved url, which is what unblocks Altair's `tabs.js`), plus a non-Chrome `openedVia`
  field saying `"external"` / `"window"` / `null`. The open itself is
  `DEVTOOLS_TABS_OPEN=none|external|window` and defaults to `none`, because both shipped
  extensions call `create` from an automated handler (graphql's `onInstalled` opens a
  marketing URL) and launching the user's real browser because a devtools session started is
  a side effect nobody asked for. Even under `external`, only `http:`/`https:` URLs reach
  `shell.openExternal` (`src/electron/extensions/internal/services/external-open.js`, shared with
  `InspectorFrontendHost.openInNewTab`): a `file:`/`smb:`/custom-scheme URL is refused, since
  the OS would launch whatever application is registered for it. `window` filters through the
  same check before it creates a window, plus this shell's own `rozenite://<id>/` pages — so
  `create` is not a route to the `file://` origin either.
- **Test seams are environment variables, off by default, and ignored by a packaged build.** `DEVTOOLS_TEST_OPEN_LOG`
  (record instead of opening a browser) and `DEVTOOLS_TEST_SAVE_DIALOG` (auto-answer the save
  dialog) exist so a headless run can prove `openInNewTab` / `save` end to end
  (docs/evidence/electron-leftovers). Setting the second makes every save, including
  `chrome.downloads` with `saveAs`, skip the real dialog — anyone who can set the shell's
  environment can already do far more, but do not set either in a user-facing launcher.
  The background worker runs ([features/BACKGROUND-WORKER.md](features/BACKGROUND-WORKER.md)),
  so `runtime.onInstalled` and `onStartup` have a producer, and
  `runtime.sendMessage`/Ports between extension frames — including to and from the worker —
  work ([features/RUNTIME-MESSAGING.md](features/RUNTIME-MESSAGING.md)).
- **`chrome.tabs.create` inside a worker without the `tabs` permission fails differently than
  in Chrome.** GraphQL Network Inspector declares `["webRequest","storage"]` and no `tabs`, and
  its `onInstalled` handler calls `chrome.tabs.create`. Chrome would not inject `chrome.tabs`
  at all there, so that line throws; this shell keeps the namespace, so the call instead
  rejects with a permission error and sets `runtime.lastError`, and the worker keeps running.
  Observed live: the worker logs the denial and survives
  (`tests/background-worker-electron.test.js`). Shape-first rule,
  [OVERVIEW.md](OVERVIEW.md).
- `chrome.devtools.panels.create` is real and shell-driven
  ([features/DEVTOOLS-PANELS.md](features/DEVTOOLS-PANELS.md)), and so are
  `devtools.inspectedWindow.eval` and `.reload` (CDP `Runtime.evaluate` / `Page.reload`
  over the host's CDP session — see
  [features/INSPECTED-WINDOW.md](features/INSPECTED-WINDOW.md) for the fidelity and the
  honest-degradation table). `devtools.network` is real too now (`onRequestFinished`,
  `getHAR`, lazy `getContent`), with two documented divergences: `onNavigated` fires on a
  debugger-session change rather than a page navigation and carries the target's title (or
  `""`), and HAR fields CDP never reported (`timings.blocked/dns/connect/ssl`,
  `headersSize`) stay HAR's own `-1` instead of a plausible number.
  `inspectedWindow.getResources` / `getSelectedNode` answer with documented no-data — of which
  only `getResources` is open: `getSelectedNode` is 🚷 (no Elements panel, no DOM), see
  [features/INSPECTED-WINDOW.md](features/INSPECTED-WINDOW.md).
- `inspectedWindow.eval` only answers when the host's CDP session is actually attached:
  no Metro, no debuggable app, a frontend URL without `ws=`, or a target that does not report
  `supportsMultipleDebuggers` (below) all surface as `exceptionInfo.isError` with the host's
  reason (`status().reason`). Nothing is answered from
  cache or invented. `inspectedWindow.reload` has no callback in Chrome's API, so the
  same failure shows up as a console warning in the extension frame.

**Host/frontend coupling**

- Depends on a **private patched RN DevTools fork** served from a Metro dev server at a
  hardcoded URL/port; nothing is packaged. Stock RN DevTools + this shell = no extension
  support.
- The frontend dials Metro's inspector proxy directly (the `?ws=` the development shell takes
  from Metro's `/json/list`, `src/electron/shell/frontend-target.js`), and the host opens
  **one** second session to that same target
  (`src/electron/extensions/internal/cdp/cdp-session.js`): one RN app target at a time, no
  multi-target/device multiplexing (`src/tools/fake-cdp.js` likewise proxies exactly one
  Chrome tab). Target *selection* is filterable (`DEVTOOLS_APP_FILTER` /
  `DEVTOOLS_DEVICE_FILTER`), multiplexing is not.
  Note that `src/tools/fake-cdp.js` is a plain proxy listening on `:9223` with no access
  rules (dev-only tool; a follow-up ticket will cover it), and the host's session does not
  attach to it, because it does not answer like Metro's `/json/list`.
- **The host's session needs `supportsMultipleDebuggers`.** Before every dial the host reads
  `<dev server>/json/list` and connects only if the entry for its `ws=` reports
  `reactNative.capabilities.supportsMultipleDebuggers === true`, because on a target without
  it the inspector proxy evicts the previous debugger, which would disconnect the frontend.
  Upstream dev-middleware forces that capability to `false` unless its
  `enableStandaloneFuseboxShell` experiment is on, so against a dev server without the
  experiment there is **no host session**: `inspectedWindow.eval` / `reload`,
  `devtools.network`, `webRequest`, content scripts and `chrome.tabs` target info fail or
  report no data with the reason. Panels, storage and messaging keep working. Not yet
  checked against a device from this checkout.
- The host's session sends `Origin: <frontend URL origin>` (the dev server's), which is what
  the inspector proxy accepts. The shell opens no listening CDP socket of its own any more;
  who may reach the app's debugger is the inspector proxy's rule, not this shell's
  ([SECURITY-PLATFORM.md](SECURITY-PLATFORM.md) F3, resolved by removing the bridge).
- Because the frontend URL carries `?ws=`, the frontend build talks to the socket itself
  and `InspectorFrontendHost.sendMessageToBackend` is never called — that Chrome escape
  hatch is structurally unavailable here, and the host reaches the backend over its own
  session instead ([features/DISPATCH-CHANNEL.md](features/DISPATCH-CHANNEL.md)).

- **Extensions see Chrome's user agent.** The host removes the `Electron/x` token from its
  session's agent and from Electron's app-wide fallback (extension frames are out-of-process
  iframes, which report the fallback). Redux DevTools otherwise takes its "Electron port" path
  and replaces real `chrome.*` namespaces with stubs. The fallback is process-wide, so the
  embedder's other sessions lose the token too.

**Security & robustness**

- Extension pages have **no Node or Electron surface**: `webSecurity: true`,
  `contextIsolation: true`, `nodeIntegration: false`, `allowRunningInsecureContent: false`,
  no raw `ipcRenderer` exposure, and no `new Function` on a host-stored script. Measured
  in a real Electron process (headless) against a `rozenite://` frame running the
  production preload — page-world `require` / `process` / `Buffer` / `ipcRenderer` are
  `undefined`, messaging and Ports still round-trip, and `chrome.*` keeps its shape
  (`tests/extension-frame-electron.test.js`). Preferences live in one place,
  `src/electron/extensions/internal/contexts/frame-security.js`, with the measurements behind each choice.
- **`sandbox: true`, done.** A sandboxed preload can only `require` `electron` (and
  `events`/`timers`/`url`), so both preloads are bundled into one file each
  (`scripts/bundle-preload.js`, output in gitignored `dist/` folders; `npm start` and the test
  harnesses rebuild them, `npm run build:preload` builds by hand). Measured by the Electron
  suites on Electron 38: the session preload still runs in `rozenite://` iframes, and
  `chrome.*`, messaging, workers and options pages work.
- Extension channels are installed per WebContents (`webContents.ipc`), never on `ipcMain`:
  only the attached frontend window and the host's background and options windows have
  them, so any other WebContents the session preload runs in (a second window, a
  `chrome.tabs` "window"-policy window) gets "no handler" for every extension channel.
- Still open, deliberately documented rather than fixed:
  - **`nodeIntegrationInSubFrames: true` stays** — measured: with it off the extension-frame
    preload does not run at all, so no `chrome.*` exists. It is load-bearing, not leftover.
  - Extension frames share the frontend's `WebContents`, so they share its one
    `webPreferences` object. Splitting them (own `WebContentsView`/partition) is the step
    that would let the two frame classes have different policies. An extension's background
    context already HAS its own `WebContents` (a hidden window) and is given the same policy
    anyway: a worker must not reach more than a panel can
    (`src/electron/extensions/internal/contexts/frame-security.js` records why that is a decision).
- **Hidden worker windows are sandboxed exactly like panels, no more.** They get the same
  policy (`sandbox: true` included), so "one hidden window per extension" buys lifecycle
  separation (a frontend reload does not kill the worker) and a separate renderer process — it
  does **not** buy a separate partition, a separate origin, or isolation the frontend-hosted
  iframes lacked. Nothing in the worker
  context is privileged, but nothing is more contained either.
- **The `rozenite://` scheme has no per-extension origin isolation, and that is measured, not
  assumed.** The traversal guard stops a path from escaping its own folder inside one request,
  asserted from inside a real extension frame (`../` → 404; a bootstrap `?script=../sibling/x`
  → 404; a symlink out of the folder → 404, resolved on `fs.realpath` —
  `tests/extension-symlink-containment.test.js`). It was never a same-origin check: a page in extension A can
  `fetch("rozenite://B/file.js")` and read the body. Verified under BOTH the old
  `registerFileProtocol` handler and the current `protocol.handle` one — identical 200 with the
  real contents — so the migration did not open this. Closing it needs per-origin isolation for
  the scheme (per-extension privileged origins, or an origin check in the handler), which this
  shell does not have. Asserted in `tests/background-worker-electron.test.js` so the gap cannot
  quietly be read as a guard.
- With `sandbox: true`, a **renderer compromise is no longer a Node compromise**: it also needs
  an OS sandbox escape. The IPC guards still limit only what an extension page can *ask*
  for, through the channels its WebContents has.
- **Permissions now gate capability.** An extension calling an API whose permission it did
  not declare gets a failing call (`runtime.lastError` + rejected promise) and, for
  `webRequest`, no deliveries at all — enforced twice, in main (`src/electron/extensions/internal/broker/delivery-scope.js`
  decides from the manifest **on disk**, so a frame cannot talk itself into data) and in the
  shim (`src/electron/extensions/internal/shim/permission-gate.js`). Both halves are measured, in one live run of
  the production shell with a CDP session (`tests/delivery-scope.test.js`), and each is
  measured by the observation that can actually see it: an entitled panel frame receives
  every `chrome.webRequest` step and `devtools.network`'s finished event; for a frame with
  no permission, the shim half is its own report that the listeners it registered were
  withdrawn (`hasListeners()` false) and that nothing but devtools.network's two events ever
  arrived, while main's half is the drop itself — the run records every push main addressed
  to a frame, and no `request` / `sendHeaders` / `response` push was ever addressed to that
  frame while `completed` was, for every cycle. (The main half had better be measured: it
  shipped **broken and silent** for its whole life — the filter was never imported, and the
  swallowed exception in the delivery fan-out meant no live push reached any frame.
  Issue #20, `docs/SECURITY-PLATFORM.md` F6.)
  Deviation from Chrome, stated: Chrome omits
  an undeclared namespace entirely, this shell keeps the namespace and fails the call
  (shape-first rule, [OVERVIEW.md](OVERVIEW.md)).
- **`chrome.notifications` is real, with three gaps.** It shows an Electron
  `Notification`, allocates the id Chrome would, and fires `onClicked`/`onClosed` from the
  notification's own click/close callbacks into the context that created it
  ([features/SMALL-SHIMS.md](features/SMALL-SHIMS.md)). What it cannot do:
  - **no real dismiss.** Electron 38 removed `Notification.close()`. `clear` drops the
    host's ownership and stops forwarding that notification's events (and the extension is
    told `onClosed`, as Chrome does), but the banner stays on screen until the user or the OS
    dismisses it.
  - **no buttons.** `onButtonClicked` and `onShowSettings` never fire; a `buttons` array in
    the options is reported as ignored rather than dropped in silence.
  - **`getPermissionLevel` is an observation, not a verdict.** It reports
    `Notification.isSupported()`. There is no permission prompt in this host to read a real
    answer from, so "granted" here means "the platform backend works", not "the user agreed".
  A notification that could not be shown is given **no id** — an id is the promise of a click.
- **`chrome.alarms` does not outlive the context that created it.** Chrome persists alarms and
  wakes the service worker to fire them; this host's background context is always-on, so there
  is nothing to wake and nothing is persisted (claiming persistence without a store would be a
  fabrication). An alarm dies with its window — the preload cancels every alarm on `pagehide`,
  asserted in `tests/alarms.test.js` — and does not survive a shell restart. Alarms are
  therefore tied to a live always-on worker rather than to MV3's evict-and-wake lifecycle
  ([features/BACKGROUND-WORKER.md](features/BACKGROUND-WORKER.md)).
- **`chrome.permissions.request` grants nothing.** `contains`/`getAll` report exactly what
  the manifest declares (the host's own verdict), and `request` resolves `true` only for
  permissions already declared — `false` for anything else, with one console line. There is
  no prompt to show and no grant to record: capability is decided from the manifest on disk,
  so an accepting `request` could only defer the refusal to the first real call. `remove`
  resolves and changes nothing; `onAdded`/`onRemoved` are registrable and never fire, because
  nothing in this shell changes a grant ([features/SMALL-SHIMS.md](features/SMALL-SHIMS.md)).
- **`chrome.downloads` is a real save with a registry scoped to this shell.** The bytes are
  written and `totalBytes` is counted from what was written
  ([features/SMALL-SHIMS.md](features/SMALL-SHIMS.md)), but:
  - **`show` and `showDefaultFolder` do nothing** — Electron 38 exposes no reveal. Both report
    that once per key rather than pretending a window was raised.
  - **the ledger is this shell's own**, so `search` answers for what this shell saved while it
    has been running: no browser download history, and nothing from before the shell started.
  - **`filename` is the path the shell wrote to**, not Chrome's `<downloads>/<n> name.ext`
    numbering, and `search`/`erase`/`cancel` are scoped to the caller's own extension id.
  - `onDeterminingFilename` runs on the timer rather than the Chrome extension thread, so an
    async suggestion must arrive within the host's window (`DEVTOOLS_SUGGEST_TIMEOUT`, 3 s) or
    the host saves under its own name and logs that it decided.
- **`options_ui.open_in_tab` means a window here, not a tab.** This shell has no browser tab,
  so the flag is reported in the window's title. Altair declares `open_in_tab: true` with no
  `tabs` permission — a combination Chrome itself warns about — and the options host reports
  that gap too rather than dropping it.
- **`commands`, `contextMenus` and `sidePanel` are injected, and none can do its headline
  trick — two of the three are 🚷.** They exist with the real method shape so a worker naming
  them at module scope loads,
  and each names what it lacks once: `commands.getAll` answers from the manifest but
  `onCommand` never fires (no shortcut routing — **open**: the Electron app menu can produce
  this one); `contextMenus` maintains a real registry with Chrome's validations but
  `onClicked` never fires 🚷 (the menu is the page's right-click menu, and there is no page);
  `sidePanel` round-trips its configuration, and **`open` rejects** 🚷 rather than resolving,
  because its promise means a panel came up and none can
  ([features/SMALL-SHIMS.md](features/SMALL-SHIMS.md)).
- **Content-script payloads no longer reach the DevTools frontend (fixed).** While the host
  multiplexed onto the frontend's CDP session by message id (the bridge, since removed), the
  backend dispatched `Runtime.bindingCalled` to that one session, so every envelope an injected
  script sent was pushed to the frontend too. It was inert there (the frontend's bindings check
  the binding name), but it was bandwidth. The host now has its own session
  (`src/electron/extensions/internal/cdp/cdp-session.js`), and the backend delivers
  `Runtime.bindingCalled` only to sessions that added that binding, so the host's binding
  stays in the host's session.
- **`chrome.debugger` forwards every command, including the ones that act on the whole app.**
  Each attached extension has a session of its own, so what it enables and hears stays its
  own. But `Debugger.pause` stops the app under the frontend too, and Hermes has one sampling
  profiler, so an extension's `Profiler.start`/`stop` can collide with a profile the
  Performance panel is recording. Nothing marks an attached extension the way Chrome's
  infobar does. React Native's backend decides what it supports. 0.88 sends no
  `Network.webSocket*` events unless `fuseboxWebSocketEventsEnabled` is on, and ignores
  `awaitPromise` ([features/DEBUGGER.md](features/DEBUGGER.md)).
- **A `.crx` is verified for integrity, not for origin.** The CRX3 signatures are checked
  as Chromium's verifier checks them (every proof verifies, one key matches the signed id),
  so a changed file is refused. The Web Store's own signature is not checked, so a `.crx`
  proves who signed it, not that the Web Store published it. CRX2 and ZIP64 archives are
  refused. A `.crx` replaced while it is being read can mix the old index with new bytes
  until its next mtime check; whole-entry reads catch that by CRC, a byte range cannot.
  A range late in a large deflated entry inflates everything before it on each request.
- **Per-extension CSP.** Every `rozenite://` response carries that extension's
  `content_security_policy`; an extension declaring none gets Chrome's MV3 default
  (`script-src 'self'; object-src 'self'`, plus `wasm-unsafe-eval` when it has a service
  worker). A declared policy that weakens `script-src`/`object-src` is not served — the
  strict default is, with one console line naming the extension. Verified live: an inline
  `<script>` in an extension page does not run.

**Bottom line:** the proof-of-concept shows the hosting + storage + panel + background-worker
plumbing works with real GraphQL tooling — an extension's `background.js` now executes, its
lifecycle events fire, and it is a messaging peer — and the network data behind
`devtools.network` / `webRequest` is real CDP rather than a stub. But the app-side half of that
network path has never been walked against a device from this checkout, and the shell is still
far from a product: no install/reload UI, content scripts that inject only when a developer
opts an extension in by hand (that path has now been walked on a device), no MV3 worker
lifecycle,
no host CDP session against a dev server without `supportsMultipleDebuggers`, deep coupling to
an unmerged frontend fork.

**Read "far from a product" against the pruned list, not against Chrome.** Some of what looks
missing here is missing because React Native DevTools has no Elements panel, no DOM, no page,
and no browser chrome to inspect — the Elements-family APIs, element selection, request
blocking, toolbar/menu/shortcut events, DOM content scripts. Those are marked 🚷 across these
docs and are closed, not deferred. What remains is
[ROADMAP.md's pruned list](ROADMAP.md#what-we-can-actually-implement-the-pruned-list).
The path forward is in [ROADMAP.md](ROADMAP.md); per-functionality state is in
[features/README.md](features/README.md).
