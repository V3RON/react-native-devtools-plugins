# Limitations of the current prototype

**Extension model**

- No extension lifecycle UI: no install/uninstall/reload or permissions model. Manifest
  parsing + enumeration are the shell's job now (`src/main/extensions.js` scans
  `extensions/`, hosts devtools pages and panels — see
  [features/DEVTOOLS-PANELS.md](features/DEVTOOLS-PANELS.md)), so the frontend needs no
  hardcoded extension list. Dropping a folder in `extensions/` and (re)loading the
  frontend installs an extension; there is no watcher or UI.
- No extension lifecycle beyond iframe hosting: **no background service workers**
  (GraphQL's and Altair's `background.js` never run), no content-script injection, no
  `action`/popup, options UI, `tabs`, `notifications`, or permission system, even though
  the manifests request them.
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
- `chrome.tabs.*` is an **inert shell** (`query()` → `[]`, events never fire —
  `src/chrome-shim/tabs.js`), enough for Altair's `tabs.query` consumers to render its
  monitor panel. The background worker itself does not run
  yet, so `runtime.onInstalled` has no producer ([features/BACKGROUND-WORKER.md](features/BACKGROUND-WORKER.md)).
  `runtime.sendMessage`/Ports between extension frames DO work now
  ([features/RUNTIME-MESSAGING.md](features/RUNTIME-MESSAGING.md)).
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

- Extensions get `ipcRenderer` directly + node integration in subframes, `webSecurity:
  false`, sandbox off: any extension folder has full Node/Electron privileges. No
  isolation or permission gating.
- Injected scripts: in-memory `Map` (lost on restart), origin-keyed, evaluated via
  `new Function`, delivered over synchronous IPC. The sync delivery is a deliberate
  exception (the script must exist before extension page scripts run — Chrome injects
  synchronously for the same reason); everything else follows the async-IPC house rule
  in `src/shared/ipc.js`. `new Function` on a host-stored script is the remaining
  hazard to replace with a validated per-extension IPC layer.

**Bottom line:** the proof-of-concept shows the hosting + storage + panel plumbing works
with real GraphQL tooling, and the network data behind `devtools.network` / `webRequest` is
now real CDP rather than a stub — but the app-side half of that path has never been walked
against a device from this checkout, and the shell is still far from a product: no
lifecycle/permission model, deep coupling to an unmerged frontend fork. The path forward is
in [ROADMAP.md](ROADMAP.md); per-functionality state is in [features/README.md](features/README.md).
