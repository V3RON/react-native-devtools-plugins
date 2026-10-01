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
- Still missing from the extension model: content-script injection, a working
  `action`/popup, options UI, `notifications`, `alarms`, a `chrome.permissions` prompt,
  and a toolbar. `action` and `notifications` exist as **registrable shells** so that a
  worker naming them at module scope can load at all
  ([features/SMALL-SHIMS.md](features/SMALL-SHIMS.md)). What HAS arrived: `tabs` answers
  with one synthetic tab for the inspected target rather than an empty list.
- DevTools pages are only "loaded" as iframes; no real separation between devtools page
  and panel frames like Chrome has.

**API fidelity**

- `chrome.webRequest` is **observe-only**: seven of Chrome's nine events come from the
  shell's own CDP `Network.*` model with real filters and `ResourceType`, but listeners can
  never block/modify/cancel a request — RN implements no CDP `Fetch` domain. `addListener`
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
- `chrome.tabs` answers with **one synthetic tab standing for the inspected RN
  target** (`src/chrome-shim/tabs.js`, [features/SMALL-SHIMS.md](features/SMALL-SHIMS.md)).
  `query`/`get`/`update` all return that same tab under the id
  `devtools.inspectedWindow.tabId` reports; its `url`/`title` come from `Target.getTargetInfo`
  while a CDP session is attached, and fall back to Chrome's own `about:blank` + `""` when it
  is not — with `status` and `windowId` left absent rather than guessed. That is **one tab
  standing in for a whole browser**: there is no tab strip, no window model, and no second
  tab, so a `windowId`/`groupId`/`title` query filter matches nothing by design.
- **`chrome.tabs.sendMessage` has no receiver yet.** It resolves `undefined` with one console
  line and is deliberately *not* routed into the extension's own runtime messaging: doing
  that would let an extension message itself and treat the success as a page having
  answered. Delivery arrives with content scripts
  ([features/CONTENT-SCRIPTS.md](features/CONTENT-SCRIPTS.md), issue #5). Deviation from
  Chrome, stated: Chrome fails this call with a connection error; this shell resolves
  `undefined`, so a caller that only checks for a response value could read it as success —
  the console line is what says otherwise.
- **`chrome.tabs.create` opens nothing by default.** It returns a real descriptor (id +
  resolved url, which is what unblocks Altair's `tabs.js`), plus a non-Chrome `openedVia`
  field saying `"external"` / `"window"` / `null`. The open itself is
  `DEVTOOLS_TABS_OPEN=none|external|window` and defaults to `none`, because both shipped
  extensions call `create` from an automated handler (graphql's `onInstalled` opens a
  marketing URL) and launching the user's real browser because a devtools session started is
  a side effect nobody asked for.
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
  `inspectedWindow.getResources` / `getSelectedNode` answer with documented no-data.
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
far from a product: no install/reload UI, no content scripts, no MV3 worker lifecycle, sandbox
still off, deep coupling to an unmerged frontend fork.
The path forward is in [ROADMAP.md](ROADMAP.md); per-functionality state is in
[features/README.md](features/README.md).
