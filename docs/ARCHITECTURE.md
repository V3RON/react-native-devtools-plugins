# Architecture of the current prototype

## Core insight

RN DevTools' frontend (Fusebox) **is** the Chrome DevTools frontend. So running Chrome
extensions in it "only" needs:

1. a place to host extension pages → iframes under a custom protocol,
2. a `chrome.*` API shim in those pages,
3. an `InspectorFrontendHost` stub the frontend can call on its "browser".

Electron provides all three.

## Repository layout

The code follows the layout the upstream port will have
([SPEC-DEBUGGER-SHELL-EXTENSIONS.md](SPEC-DEBUGGER-SHELL-EXTENSIONS.md) §5.1–§5.3): the
extension host behind one public entry, and this repository's development shell beside it.

```
src/electron/
├── extensions/              the extension host (what gets ported)
│   ├── index.js             public API: registerExtensionSchemes, createExtensionHost
│   └── internal/
│       ├── ExtensionHost.js composition root: builds every service, attachWindow, dispose
│       ├── settings.js      the host's configuration (set by createExtensionHost; no env)
│       ├── scheme/          rozenite:// privileges + session protocol handler, CSP, URL helpers
│       ├── registry/        extension packages (packages/), scan, manifests + i18n, install state
│       ├── broker/          extension IPC channels, frame principals, grants, delivery scope
│       ├── frontend/        panel host, panel bridge (main-world source), theme, frontend guard
│       ├── contexts/        message router, context registry/requests, background + options hosts,
│       │                    frame policy (webPreferences)
│       ├── cdp/             the host's CDP session, inspectedWindow, network model/service
│       ├── content/         content-script registry, gate, bridge + in-app loader
│       ├── services/        storage, notifications, downloads/save, tabs, external open
│       ├── preload/         the extension preload (registered on the session): extension
│       │                    frame (chrome.*) | frontend bridge (__RN_DEVTOOLS_EXTENSIONS__)
│       └── shim/            pure chrome.* logic; backends & transports injected by the caller
└── shell/                   development shell — stands in for upstream's debugger-shell; not ported
    ├── main.js, window.js   lifecycle + the frontend window, over the public API only
    ├── config.js            DEVTOOLS_* env → the shell's options + extensionHostConfig()
    ├── frontend-target.js   picks the app from Metro's /json/list when the URL names no ws=
    ├── preload.js           the window's own preload → frontend-host.js (InspectorFrontendHost)
    └── ipc.js, channels.js, frontend-frame.js, host-files.js, host-config.js,
        context-menu.js, dispatch.js, window-open-policy.js
src/tools/                   dev-only tools (fake-cdp)
scripts/bundle-preload.js    bundles each preload into one file (both run sandboxed)
extensions/                  "installed extensions": sample-extension/, graphql/, altair/, showcase/
```

Boundary rules, asserted by `tests/architecture-boundary.test.js`: the shell imports
`extensions/index.js` only (two allowlisted exceptions: its InspectorFrontendHost save and
open-in-new-tab reuse `services/save-service` and `services/external-open`); nothing under
`extensions/` imports the shell or reads `process.env`; nothing under `extensions/internal`
builds a service at import time. Inside the host, imports point downward:
`shim` ← `preload`; the preload contains no policy and the shim never touches
`window`/`ipcRenderer`. `frontend/panel-bridge.js` is off the graph: it is a plain
expression `executeJavaScript`-ed into the frontend's main world, never `require`d.

## Components

### Electron main process (`src/electron/`)

- `extensions/internal/ExtensionHost.js` — the composition root. `createExtensionHost`
  registers the scheme handler and the extension preload on the session, builds every
  service and the IPC broker; `attachWindow` (one window in v1) starts the frontend guard,
  panel host, its own CDP session, content bridge and background contexts, and the window's `closed`
  detaches them — worker windows close with it, so `window-all-closed` quits as usual;
  `dispose` (on `will-quit`) flushes storage and unregisters everything.
- `shell/main.js` — the development shell's lifecycle wiring, over the public API only.
  `shell/window.js` — BrowserWindow + frontend load.
  `shell/config.js` — frontend URL (`http://127.0.0.1:8081/rozenite/rn_fusebox.html`, no
  `ws=`), extensions dir, target filters; all env-overridable: `DEVTOOLS_FRONTEND_URL`,
  `DEVTOOLS_EXTENSIONS_DIR`,
  `DEVTOOLS_SHOW_PANEL` (`<extensionId>[/<pagePath>]`: open on that extension's panel),
  `DEVTOOLS_METRO_HOST` / `DEVTOOLS_METRO_PORT`,
  `DEVTOOLS_APP_FILTER` / `DEVTOOLS_DEVICE_FILTER`, `DEVTOOLS_CDP_REQUEST_TIMEOUT_MS` (the
  host session's command timeout),
  `DEVTOOLS_UI_LOCALE` (UI locale `chrome.i18n` reports; default: Electron's).
  `shell/frontend-target.js` — when the frontend URL names no `ws=`/`wss=`, polls Metro's
  `/json/list`, takes the first `type: node` target that passes the app/device filters and
  loads the frontend with that target's debugger URL as `?ws=`. The frontend then dials
  Metro's inspector proxy directly, as it does when dev-middleware launches it upstream.
  The frontend is a patched RN
  DevTools fork ("rozenite") that renders extension panels as iframes; it is **not** in
  this repo.
- `cdp-session.js` — **the host's own debugger session**, a second CDP session to the
  target in the attached frontend URL's `ws=` (or `wss=`), next to the frontend's. Nothing
  sits between the frontend and the app: no listening socket, no URL rewrite, no id
  multiplexing. It sends `Origin: <frontend URL origin>` (the dev server's, which the
  inspector proxy requires), and before every dial it GETs `<dev server>/json/list`, finds
  the entry for that `ws=` and requires `reactNative.capabilities.supportsMultipleDebuggers
  === true`; otherwise it does not connect, because a second debugger would evict the
  frontend, and every command rejects with the reason (`status().reason`). Each new session
  sends `Runtime.enable`, then fires `onAttach`, where consumers re-arm what a session owns
  (`Network.enable`, `Runtime.addBinding`). A lost socket is re-dialled with back-off. It
  exposes `sendCommand(method, params) → Promise`, `onEvent(method, handler)`, `onAttach`
  and `status()`. Injected transports/logging (no Electron import) keep it unit-testable
  against a fake inspector proxy (`tests/cdp-session.test.js`). Per-session isolation is the
  backend's: `Runtime.bindingCalled` reaches only sessions that added that binding, and
  `Network.*` fans out to each session that enabled the domain.
- `inspected-window.js` — `chrome.devtools.inspectedWindow.eval` / `.reload` as
  `Runtime.evaluate` / `Page.reload` on that session, with the pure CDP → Chrome
  `[value, exceptionInfo]` mapping (`mapEvaluation`).
- `debugger-service.js` — `chrome.debugger`: one more `CdpSession` per attached extension, to
  the same target, with `reconnect: false`, no prime and no command timeout. Commands are
  forwarded unchanged and answered by the app; the session's events and its close
  (`onDetach("target_closed")`) go to every context of that extension. The service owns
  only the API contract: one attachment per extension, which debuggee names the app, and
  Chrome's error texts. [features/DEBUGGER.md](features/DEBUGGER.md).
- `network-model.js` + `network-service.js` — the shell's own network model, built from the
  host session's `Network.*` notifications (`requestWillBeSent` → `loadingFinished`/`loadingFailed`)
  with lazy single-flight `Network.enable`, a bounded record buffer, HAR 1.2 output and lazy
  `Network.getResponseBody` bodies. The service fans one message per lifecycle step out to
  the extension frames that asked for network data and serves `getHar` / `getStatus` /
  `getBody` over async IPC. No Electron, no session import: `sendCommand` / `onEvent` are
  injected, so the model is unit-testable without a socket.
  [features/DEVTOOLS-NETWORK.md](features/DEVTOOLS-NETWORK.md).
- `registry/packages/` — **extension packages**: one read-only object per installed
  extension (`entry`, `list`, `read`, `readText`, `open(path, {start, end})`), addressed by
  inner path and never handing out an OS path. Every reader of extension files goes through
  one: the file server, the scans, i18n, content scripts, the broker's panel-page check.
  Implementations: a folder under `extensions/` (`directory-package.js`), a signed `.crx`
  in that folder read in place (`crx-package.js` over `crx.js` + `zip.js`: CRX3 verified as
  Chromium's verifier does, Chrome's id from the signing key, ranges by seeking a stored
  entry or inflating a deflated one), and an in-memory one for tests (`memory-package.js`);
  `tests/extension-packages.test.js` runs one contract suite against all three. A folder
  wins over a `.crx` with the same id. The folder's containment rule lives there once (it used to be copied
  into the i18n reader): decided on `fs.realpath` of both the folder and the target, so a
  symlink planted inside an extension cannot point outside it, and a symlinked folder is
  never an extension root — the same verdict the scan reaches, because `readdir` +
  `isDirectory()` never reports a link (`tests/extension-symlink-containment.test.js`).
- `extension-server.js` — registers the privileged custom scheme **`rozenite://`**
  mapping `rozenite://<extension-id>/<path>` to that extension's package. **Installing an
  extension = dropping its unpacked folder into `extensions/`.** Every response carries that extension's CSP
  (`src/electron/extensions/internal/scheme/csp.js`): its own `content_security_policy`, or Chrome's MV3 default.
  The handler is **`protocol.handle`**, not the deprecated `registerFileProtocol`, because
  one response kind has no bytes on disk: the reserved path
  `rozenite://<id>/__rozenite_background__?script=<path>&type=<classic|module>` returns a
  **synthesized bootstrap document** for an extension's background context. It has to be
  generated — the extension folder is a read-only install — and its only body content is one
  same-origin `<script src=…>`, because the CSP this server itself enforces
  (`script-src 'self'`) would refuse the inline script the alternative implies. Files are
  streamed from the package with a type from `scheme/mime.js` (a module script with the
  wrong type is a hard load failure; a name with no known extension gets no type, so
  Chromium sniffs it as its `file://` loader did) and the extension's CSP. One byte range
  per request is honoured (`scheme/range.js`: `206` + `Content-Range`, `416` past the end,
  `Accept-Ranges: bytes` always), and the scheme carries the `stream` privilege, so an
  extension's own `<video>`/`<audio>` streams and seeks (`tests/range-electron.test.js`).
  Reserved paths are reserved in both directions, so a real file cannot shadow the bootstrap
  and `?script=` cannot name a file outside the extension — it goes through the same
  containment check as any other request.
- `background-host.js` — one hidden `BrowserWindow` (`show: false`) per extension that
  declares a background (`docs/features/BACKGROUND-WORKER.md`). It is **a third execution
  context**, next to the frontend's main frame and the extension iframes inside it: the
  worker's document is the main frame of its own window, so `src/electron/extensions/internal/preload/index.js` dispatches
  on the **protocol first** (an extension page is an extension page whether it is an iframe or
  a window's top frame) and the worker gets the same shim, gate, and `RUNTIME_REGISTER` seat
  as a panel. `did-fail-load`, `render-process-gone`, `unresponsive` and the worker's console
  are relayed with the extension id, with Electron 38's string log-levels normalized to a
  number — a level that silently reads as `log` is how a dead worker stops being reportable.
- `install-state.js` — which extension versions the host has seen (`{version, installedAt}`
  in `electron-store`, under `userData`), and therefore whether a worker's first event is
  `onInstalled{install}`, `onInstalled{update}`, or `onStartup`.
- `frame-security.js` — the one place webPreferences are decided, with the measured
  reasons for each option. `ipc.js` collects every channel's handler and installs them on
  `webContents.ipc` of each WebContents the host attached (the frontend window, every
  background and options window, before they load), never on `ipcMain`, so any other
  WebContents gets "no handler" for every extension channel. It gates each call on the
  calling frame (`event.senderFrame` + `event.frameId`, pinned to the principal that
  registered it), and consults `delivery-scope.js` so a frame only receives deliveries
  its declared permissions cover.
- `message-router.js` — the runtime-messaging relay: registry of live extension frames
  (identity derived main-side from the frame itself), `sendMessage` fan-out with
  Chrome response-settling, Port lifecycle. `dispatch.js` + `context-menu.js` — the
  host→frontend dispatch channel and its first consumer.

### Security model (`src/electron/extensions/internal/contexts/frame-security.js`)

One `webPreferences` object per `WebContents`. Every extension **iframe** (devtools page,
panels) lives inside the frontend's own frame tree — `src/electron/extensions/internal/frontend/panel-bridge.js` creates
them — so the frontend and those frames necessarily share one policy, and that is what
`basePreferences` encodes. An extension's **background context** has its own `WebContents` and
could therefore have a different policy; it uses the same table anyway, deliberately: the two
contexts must not differ in what they can reach, and `extensionFramePreferences()` exists so
that any future split is a decision rather than an accident. What the policy is, and what each
option was measured to do (Electron 38, headless, a real `rozenite://` frame loading the
production preload):

| Option | Value | Why |
| --- | --- | --- |
| `webSecurity` | `true` | `rozenite://` iframes still load inside the `http://127.0.0.1:8081` frontend, because the scheme is registered `standard` + `supportFetchAPI` + `bypassCSP`. The old off-switch was never what made panel hosting work. |
| `contextIsolation` | `true` | the page world gets `chrome` through `contextBridge` only |
| `nodeIntegration` | `false` | no `require`/`process`/`Buffer` in any page world (asserted) |
| `allowRunningInsecureContent` | `false` | with `webSecurity` on, otherwise a secure extension page could pull `http://` subresources |
| `nodeIntegrationInSubFrames` | `true` | **load-bearing**: with it off the extension-frame preload never runs, so no `chrome.*` exists at all |
| `sandbox` | `true` | a sandboxed preload can `require` only `electron` (and `events`/`timers`/`url`), so each preload is one bundled file (`scripts/bundle-preload.js`, output in gitignored `dist/`). Measured by the Electron suites on Electron 38: the session preload still runs in `rozenite://` iframes, and `chrome.*`, messaging, workers and options pages work |

So an extension page reaches the host only through named, validated `invoke` channels,
and each channel re-derives identity from the calling frame. The remaining gaps are
listed honestly in [LIMITATIONS.md](LIMITATIONS.md): one shared `webPreferences`, and one
shared `rozenite://` origin for every extension.

The end-to-end assertions for all of this live in `tests/extension-frame-electron.test.js`
+ `tests/extension-frame-harness.js`, which boots a production-shaped shell headlessly
(`show: false`, no Metro, so no CDP session) — an extension frame needs neither a
device nor the frontend to be observable. One run goes further: `--fake-rn-app=on` serves a
fake inspected app inside the harness (on a port the OS picks, reported back on the NDJSON
`harness` line) and points the real CDP session at it, which is how
`tests/delivery-scope.test.js` proves a live network push actually reaches a subscribed frame
and records the pushes main addressed to each frame, so a filtered-out one is visible too
(see F6 in [SECURITY-PLATFORM.md](SECURITY-PLATFORM.md) for why those assertions exist).

### Main-frame preload (`src/electron/shell/frontend-host.js`)

- Implements **`InspectorFrontendHost`** — the ~60-method host interface the frontend
  expects Chrome to provide. Methods are grouped into explicit **[REAL] / [FAKE] /
  [STUB]** clusters mirroring the gap analysis:
  [api/INSPECTOR-FRONTEND-HOST.md](api/INSPECTOR-FRONTEND-HOST.md). `isHostedMode()`
  returns `true`. Bridged via `contextBridge`, merged into `window.InspectorFrontendHost`
  via `executeInMainWorld`.
- `setInjectedScriptForOrigin(origin, script)` is a documented **no-op**. It used to be the
  channel through which the frontend fork shipped a `chrome.devtools.*` implementation into
  extension frames, to be stored in main and `new Function`'d into every frame of that
  origin. `chrome.devtools.*` is now implemented shell-side in `src/electron/extensions/internal/shim/devtools.js`,
  so the channel, its in-memory store, and the two `sendSync` exceptions that carried it are
  all gone — which makes the async-IPC house rule in `src/electron/extensions/internal/broker/channels.js` unconditional.

### Extension-iframe preload (`src/electron/extensions/internal/preload/extension-frame.js`)

Any iframe loaded under `rozenite:` (hostname = extension id) gets, in order — and this is
also what an extension's **background context** gets, since that is a `rozenite:` document in
a hidden window of its own:

- the **`chrome` namespace** assembled by `src/electron/extensions/internal/shim`, merged onto `window.chrome`
  (its `devtools.inspectedWindow.eval` / `.reload` are wired to the async `DEVTOOLS_EVAL`
  / `DEVTOOLS_RELOAD` IPC channels, answered by `src/electron/extensions/internal/cdp/inspected-window.js`; its network
  APIs are wired to `NETWORK_SUBSCRIBE` / `NETWORK_GET_HAR` / `NETWORK_GET_STATUS` /
  `NETWORK_GET_BODY`, with `NETWORK_DELIVER` as the host's push channel);
- a **permission gate** (`src/electron/extensions/internal/broker/permissions.js` + `src/electron/extensions/internal/shim/permission-gate.js`)
  seeded from the grants `RUNTIME_REGISTER` derives from the manifest **on disk** — so the
  verdict is the host's, and a page-world script cannot widen it by replacing
  `chrome.runtime.getManifest`;
- a **startup delivery queue** on `RUNTIME_DELIVER`, flushed at `DOMContentLoaded`. The host
  pushes a frame's first delivery (a lifecycle event, for a worker) the instant it registers,
  which is during preload evaluation — before the page's listeners exist. Chrome has the same
  rule for the same reason;
- nothing else. No raw `ipcRenderer`, no injected-script fetch, no Node globals: the page
  world has named channels only.

### Chrome API shim (`src/electron/extensions/internal/shim/`)

Pure modules; `index.js` assembles the namespace from injected deps:

- `storage.js` — real `chrome.storage.local/sync/session` ([REAL]): the API shape (promise +
  callback, `lastError`, per-area and global `onChanged`) as a thin client of the HOST's store
  (`src/electron/extensions/internal/services/storage-service.js`: one store per extension for all its contexts, electron-store
  for local/sync, memory for session, change events fanned out to every context of that
  extension over `STORAGE_DELIVER`). The semantics live in `src/electron/extensions/internal/services/storage-core.js`.
- `network-bridge.js` — `chrome.devtools.network` **and** `chrome.webRequest`, both fed by
  the host's one CDP network model: the frame subscribes on its first listener, the host
  pushes one delivery per lifecycle step, and this module decides which Chrome event each
  step becomes (filters matched locally, real `Event` objects, `Request` objects with lazy
  `getContent`). Reads (`getHAR`, status, bodies) are injected async host calls. Nothing is
  invented: an unavailable capture stays an empty list plus one console sentence
  ([features/DEVTOOLS-NETWORK.md](features/DEVTOOLS-NETWORK.md),
  [features/WEBREQUEST.md](features/WEBREQUEST.md)). `web-request.js` holds the CDP →
  webRequest mapping and Chrome's URL-pattern matching, pure.
- `runtime.js` + `messaging.js` — identity (`id`/`getURL`/`getManifest`/platform) and
  real `sendMessage`/Ports, relayed by the host message router
  ([REAL, extension-scoped]); `onInstalled`/`onStartup` are produced by the background host
  ([features/BACKGROUND-WORKER.md](features/BACKGROUND-WORKER.md)). `getBackgroundPage()`
  stays `undefined`, which is also Chrome's answer for an MV3 extension.
  `event.js` provides Chrome-semantics Event objects shared across the shim.
- `browser-apis.js` + `browser-shells.js` — the browser-UI namespaces. `notifications` is
  **real**: an injected `show`/`hide` pair (Electron `Notification` on the host side), the id
  Chrome allocates only when something really showed, and `onClicked`/`onClosed` forwarded
  from the notification's own callbacks into the context that created it. `action` stays a
  **registrable no-op shell**: it exists so an MV3 worker that names it at module scope can
  load at all (an ESM worker's top-level statements run first, so a missing namespace kills
  the whole context); there is no toolbar to render a badge or a click.
  `browser-shells.js` is the same trick for `commands` / `contextMenus` / `sidePanel`, where
  what is missing is a **producer**: `commands.getAll` reads the manifest, `contextMenus`
  keeps a real registry with Chrome's validations, `sidePanel` round-trips its options — and
  no event fires, because a keypress or a click that never happened is exactly what those
  handlers act on (`sidePanel.open` rejects rather than resolving). Both files take every
  host capability as an injected dependency, so a context with nothing injected answers
  honestly instead of failing. `notifications` is permission-gated like Chrome's; `action`,
  `commands`, `contextMenus` and `sidePanel` are ungated like Chrome's
  ([features/SMALL-SHIMS.md](features/SMALL-SHIMS.md)).
- `permissions-api.js`, `alarms.js`, `downloads.js`, `tab-model.js` — the rest of Tier 2:
  what the manifest really grants (never what the page claims), timers in the context that
  created them, saves over main's one save path, and the one synthetic tab's descriptor.
- `async-style.js` — `promiseOrCallback`, the one place Chrome's promise+callback duality and
  `lastError` scoping are implemented; every Tier-2 namespace goes through it.
- `devtools.js` — `chrome.devtools.*`: real `panels.create` (host-driven tabs), real
  `inspectedWindow.eval` against an injected `evalInPage` host dependency
  ([features/INSPECTED-WINDOW.md](features/INSPECTED-WINDOW.md)), `panels.network.getHAR`
  on the shared network bridge, a live `panels.themeName`/`setThemeChangeHandler` fed by the host's
  theme state (`src/electron/extensions/internal/frontend/theme-host.js`), and otherwise inert panel events
  ([features/DEVTOOLS-PANELS.md](features/DEVTOOLS-PANELS.md)). `tabs.js` answers with the
  ONE tab this shell has — the inspected RN target, under the id
  `devtools.inspectedWindow.tabId` reports — with url/title read from the host's CDP target
  info and `create`/`remove` driving the host's own open policy.
  Full gap analysis: [api/CHROME-EXTENSION-APIS.md](api/CHROME-EXTENSION-APIS.md).

### Shell-driven extension hosting (`src/electron/extensions/internal/registry/extensions.js`, `src/electron/extensions/internal/frontend/panel-host.js`, `src/electron/extensions/internal/frontend/panel-bridge.js`)

Replaces hardcoded fork knowledge end-to-end
([features/DEVTOOLS-PANELS.md](features/DEVTOOLS-PANELS.md)): `extensions.js` scans
`extensionsDir` and parses manifests; `panel-host.js` evaluates the bridge into the
frontend on every load (after `.main-tabbed-pane` appears) and owns the live panel
registry; the bridge imports the frontend's own `ui/legacy/legacy.js` (same module
instance, same `InspectorView` singleton), spawns hidden devtools-page iframes, and
turns `chrome.devtools.panels.create` IPCs into real tabs (`SimpleView` + iframe).
Devtools-side API surface lives in `chrome-shim/devtools.js` (panels/inspectedWindow/
network); `chrome.tabs` answers with the one tab this shell has
(`chrome-shim/tabs.js` + `tab-model.js`), driven by the host's CDP target info.

### `src/tools/fake-cdp.js` — dev convenience (`npm run fake-cdp`)

WebSocket proxy: DevTools frontend ⇄ a real Chrome tab's CDP endpoint (port 9222,
`--target-url` selects the tab), listening on `:9223`. Lets extension behavior be developed
against a web app: start the shell with
`DEVTOOLS_FRONTEND_URL=…/rn_fusebox.html?ws=localhost:9223`. It feeds the frontend only; the
host's own session does not attach, because the proxy does not answer like Metro's
`/json/list`, so CDP-backed extension APIs report no session.

## Data flows (current)

```
   RN app  ⇄  Metro inspector proxy (/inspector/debug, /json/list)
                 ▲                              ▲
                 │ session 1: the frontend's    │ session 2: the host's own
                 │ own (?ws= from               │ (Origin: dev server; dialled only
                 │  frontend-target.js)         │  if supportsMultipleDebuggers)
                 ▼                              │
   DevTools frontend (main frame)               │
   │ InspectorFrontendHost.* (preload stubs)    │
   │ setInjectedScriptForOrigin ──► no-op       │
   ▼                                            ▼
   extension iframes  rozenite://<id>/<page>    host ──► CdpSession (internal/cdp/cdp-session.js)
   (preload: chrome shim, no Node surface)      │  sendCommand(method, params) → Promise
        ▲                                       │  onEvent / onAttach (re-arm on reconnect)
        │ async IPC (per-WebContents handlers)  │
        └──────────────────────────────────────►├── Runtime.evaluate / Page.reload ◄── inspected-window.js
                                                │                       (DEVTOOLS_EVAL / DEVTOOLS_RELOAD)
                                                └── Network.* ◄─► network-model.js ──► network-service.js
                                                     (Network.enable per session,    │  one delivery per lifecycle step,
                                                      HAR 1.2, bodies)               ▼
                                                                  chrome.devtools.network + chrome.webRequest
```

Two sessions to the same target, each with its own subscriptions: the backend scopes
`Runtime.bindingCalled` to the session that added the binding and fans `Network.*` out to
each session that enabled the domain, so the frontend never sees a host command, event or
binding, and the host never sees the frontend's. The host's `Network.enable` session serves
every extension frame — the model accumulates once in main and fans out.

## Execution contexts, current

| Context | Where it runs | Frame tree | Created by |
| --- | --- | --- | --- |
| DevTools frontend | main frame of the visible `BrowserWindow` | its own | `window.js` |
| devtools page, panel pages | `rozenite://` iframes | **the frontend's** | `src/electron/extensions/internal/frontend/panel-bridge.js` |
| **background context** (MV3 worker) | main frame of a hidden `BrowserWindow`, one per extension | **its own** | `src/electron/extensions/internal/contexts/background-host.js` |
| injected content scripts | **inside the inspected app**, not in any Electron context | none — the app is not a frame tree | `src/electron/extensions/internal/content/content-bridge.js`, over the CDP session, only for extensions named in `DEVTOOLS_CONTENT_SCRIPTS` |

```
 frontend window (visible)                      extension windows (show:false, one per extension)
 ┌──────────────────────────────┐               ┌─────────────────────────────────────────────┐
 │ main frame: the frontend     │               │ main frame:                                  │
 │   iframe rozenite://<id>/…  │               │  rozenite://<id>/__rozenite_background__      │
 │   iframe rozenite://<id>/…  │               │    ?script=<path>&type=<classic|module>       │
 └──────────────┬───────────────┘               └──────────────────────┬──────────────────────┘
                │  extension-frame preload: chrome.* shim + gate  (identical on both sides)     │
                └──────────────────────────┬───────────────────────────────────────────────────┘
                                           ▼  RUNTIME_REGISTER / RUNTIME_DELIVER — one path, no bypass
                  main: message-router  ◄──  background-host (lifecycle)  ◄──  install-state
```

The split is deliberate: a worker does **not** live in the frontend's frame tree, so reloading
the frontend does not take the extension's background down with it
([features/BACKGROUND-WORKER.md](features/BACKGROUND-WORKER.md)). Both context kinds are
ordinary router peers, addressed by the `WebFrameMain` the principal check already verified,
and both derive their extension identity from the frame's own URL — never from payload.

Target status per functionality: [features/README.md](features/README.md).
