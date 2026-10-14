# Limitations of the current prototype

**Extension model**

- No extension lifecycle UI: no install/uninstall/reload or permissions prompt. Manifest
  parsing + enumeration are the shell's job now (`src/main/extensions.js` scans
  `extensions/` for devtools pages **and** backgrounds and hosts both — see
  [features/DEVTOOLS-PANELS.md](features/DEVTOOLS-PANELS.md) and
  [features/BACKGROUND-WORKER.md](features/BACKGROUND-WORKER.md)), so the frontend needs no
  hardcoded extension list. Dropping a folder in `extensions/` and (re)loading the
  frontend installs an extension; there is no watcher or UI.
- **Background service workers run now** — as an always-on hidden `BrowserWindow` per
  extension, against the same `chrome.*` shim, with `runtime.onInstalled`/`onStartup` firing
  and the worker as an ordinary messaging peer (`src/main/background-host.js`,
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
  globals. Observed on a real device; the message-loss gap that run found is fixed and
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
  target** (`src/chrome-shim/tabs.js`, [features/SMALL-SHIMS.md](features/SMALL-SHIMS.md)).
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
  `shell.openExternal` (`src/main/external-open.js`, shared with
  `InspectorFrontendHost.openInNewTab`): a `file:`/`smb:`/custom-scheme URL is refused, since
  the OS would launch whatever application is registered for it.
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
  over the shell's CDP bridge — see
  [features/INSPECTED-WINDOW.md](features/INSPECTED-WINDOW.md) for the fidelity and the
  honest-degradation table). `devtools.network` is real too now (`onRequestFinished`,
  `getHAR`, lazy `getContent`), with two documented divergences: `onNavigated` fires on a
  debugger-session change rather than a page navigation and carries the target's title (or
  `""`), and HAR fields CDP never reported (`timings.blocked/dns/connect/ssl`,
  `headersSize`) stay HAR's own `-1` instead of a plausible number.
  `inspectedWindow.getResources` / `getSelectedNode` answer with documented no-data — of which
  only `getResources` is open: `getSelectedNode` is 🚷 (no Elements panel, no DOM), see
  [features/INSPECTED-WINDOW.md](features/INSPECTED-WINDOW.md).
- `inspectedWindow.eval` only answers when the shell's CDP bridge actually has a session:
  no Metro, no debuggable app, or `DEVTOOLS_CDP_BRIDGE=off` without an external relay all
  surface as `exceptionInfo.isError` with the host's reason. Nothing is answered from
  cache or invented. `inspectedWindow.reload` has no callback in Chrome's API, so the
  same failure shows up as a console warning in the extension frame.

**Host/frontend coupling**

- Depends on a **private patched RN DevTools fork** served from a Metro dev server at a
  hardcoded URL/port; nothing is packaged. Stock RN DevTools + this shell = no extension
  support.
- The frontend's CDP endpoint is fixed at `?ws=localhost:<port>` (default 9223) and the
  bridge keeps **exactly one** upstream debugger session: one RN app target at a time, no
  multi-target/device multiplexing (`src/tools/fake-cdp.js` likewise proxies exactly one
  Chrome tab). Target *selection* is filterable (`DEVTOOLS_APP_FILTER` /
  `DEVTOOLS_DEVICE_FILTER`), multiplexing is not.
- The CDP socket has **one owner**, and a second client is *refused* rather than taking
  over (`close 4001` + a warning in the shell's terminal). That is a divergence from
  Chrome, where a second DevTools page evicts the first: here eviction was the attack
  ([SECURITY-PLATFORM.md](SECURITY-PLATFORM.md) F3), so takeover is a visible refusal.
  A frontend **reload** still reattaches — the old socket's close frees the seat, and an
  owner that stops answering pings loses it after the bridge's liveness probe times out
  (~1 s). There is no shared session and no way to ask politely for the seat.
- That socket is bound to loopback only and accepts the frontend's own `Origin` (plus
  `DEVTOOLS_CDP_ALLOWED_ORIGINS`) or no `Origin` at all from a local peer. Consequences:
  a non-browser tool on this machine connects freely, a web page on any other origin
  cannot, and serving the frontend from another host needs an explicit
  `DEVTOOLS_CDP_ALLOWED_ORIGINS` (or `DEVTOOLS_CDP_HOST` to bind elsewhere at all).
- Because the frontend URL carries `?ws=`, the frontend build talks to the socket itself
  and `InspectorFrontendHost.sendMessageToBackend` is never called — that Chrome escape
  hatch is structurally unavailable here, and the host reaches the backend on the socket
  instead ([features/DISPATCH-CHANNEL.md](features/DISPATCH-CHANNEL.md)).

**Security & robustness**

- Extension pages have **no Node or Electron surface**: `webSecurity: true`,
  `contextIsolation: true`, `nodeIntegration: false`, `allowRunningInsecureContent: false`,
  no raw `ipcRenderer` exposure, and no `new Function` on a host-stored script. Measured
  in a real Electron process (headless) against a `rozenite://` frame running the
  production preload — page-world `require` / `process` / `Buffer` / `ipcRenderer` are
  `undefined`, messaging and Ports still round-trip, and `chrome.*` keeps its shape
  (`tests/extension-frame-electron.test.js`). Preferences live in one place,
  `src/main/frame-security.js`, with the measurements behind each choice.
- Still open, deliberately documented rather than fixed:
  - **`sandbox: false`.** A sandboxed preload can only `require` Electron's built-in
    subset, not this repo's preload modules — enabling it means shipping one bundled,
    self-contained preload file, i.e. the build step this PoC deliberately does not have.
    Isolation today therefore rests on context isolation plus the fact that the preload
    exposes only named, validated channels. Frame records show whether a frame is in a
    separate renderer process; while sandbox is off, that is all the isolation that exists.
  - **`nodeIntegrationInSubFrames: true` stays** — measured: with it off the extension-frame
    preload does not run at all, so no `chrome.*` exists. It is load-bearing, not leftover.
  - Extension frames share the frontend's `WebContents`, so they share its one
    `webPreferences` object. Splitting them (own `WebContentsView`/partition) is the step
    that would let the two frame classes have different policies. An extension's background
    context already HAS its own `WebContents` (a hidden window) and is given the same policy
    anyway: a worker must not reach more than a panel can
    (`src/main/frame-security.js` records why that is a decision).
- **Hidden worker windows are no better sandboxed than panels.** `sandbox: false` applies to
  them too, so "one hidden window per extension" buys lifecycle separation (a frontend reload
  does not kill the worker) and a separate renderer process — it does **not** buy a sandbox, a
  separate partition, or isolation the frontend-hosted iframes lacked. Nothing in the worker
  context is privileged, but nothing is more contained either.
- **The `rozenite://` scheme has no per-extension origin isolation, and that is measured, not
  assumed.** The traversal guard stops a path from escaping its own folder inside one request,
  asserted from inside a real extension frame (`../` → 404; a bootstrap `?script=../sibling/x`
  → 404). It was never a same-origin check: a page in extension A can
  `fetch("rozenite://B/file.js")` and read the body. Verified under BOTH the old
  `registerFileProtocol` handler and the current `protocol.handle` one — identical 200 with the
  real contents — so the migration did not open this. Closing it needs per-origin isolation for
  the scheme (per-extension privileged origins, or an origin check in the handler), which this
  shell does not have. Asserted in `tests/background-worker-electron.test.js` so the gap cannot
  quietly be read as a guard.
- `sandbox: false` also means a **renderer compromise is a Node compromise**: the guards
  here limit what an extension page can *ask* for, not what a compromised renderer can do.
- **Permissions now gate capability.** An extension calling an API whose permission it did
  not declare gets a failing call (`runtime.lastError` + rejected promise) and, for
  `webRequest`, no deliveries at all — enforced twice, in main (`src/main/delivery-scope.js`
  decides from the manifest **on disk**, so a frame cannot talk itself into data) and in the
  shim (`src/chrome-shim/permission-gate.js`). Deviation from Chrome, stated: Chrome omits
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
- **A content script's app→host payloads are also relayed to the DevTools frontend.** The host
  does not open a second debugger connection — it multiplexes onto the frontend's CDP session by
  message id (`src/main/cdp-bridge.js`) — and the backend dispatches `Runtime.bindingCalled` to
  every session on that connection, so every envelope an injected script sends is pushed to the
  frontend too, base64 blobs included. It is inert there: the frontend's React-DevTools bindings
  each check the binding NAME before touching a payload (`__FUSEBOX_REACT_DEVTOOLS_DISPATCHER__`,
  and two more that only install when their panel is open), and the host ignores any name but its
  own. So this is bandwidth, not corruption — noted because the bridge's own rule for host
  *replies* is "never forward them", and notifications have no message id to apply that rule to.
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
sandbox still off, deep coupling to an unmerged frontend fork.

**Read "far from a product" against the pruned list, not against Chrome.** Some of what looks
missing here is missing because React Native DevTools has no Elements panel, no DOM, no page,
and no browser chrome to inspect — the Elements-family APIs, element selection, request
blocking, toolbar/menu/shortcut events, DOM content scripts. Those are marked 🚷 across these
docs and are closed, not deferred. What remains is
[ROADMAP.md's pruned list](ROADMAP.md#what-we-can-actually-implement-the-pruned-list).
The path forward is in [ROADMAP.md](ROADMAP.md); per-functionality state is in
[features/README.md](features/README.md).
