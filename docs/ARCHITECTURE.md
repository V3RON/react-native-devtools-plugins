# Architecture of the current prototype

## Core insight

RN DevTools' frontend (Fusebox) **is** the Chrome DevTools frontend. So running Chrome
extensions in it "only" needs:

1. a place to host extension pages → iframes under a custom protocol,
2. a `chrome.*` API shim in those pages,
3. an `InspectorFrontendHost` stub the frontend can call on its "browser".

Electron provides all three.

## Repository layout

```
src/
├── shared/          cross-realm contracts only: ipc channel names, protocol scheme/helpers
├── chrome-shim/     pure chrome.* logic; backends & transports injected by the caller
├── main/            Electron main process: state + services
├── preload/         thin transport layer (frontend-host / extension-frame)
├── frontend/        code evaluated into the frontend's main world (panel-bridge)
└── tools/           dev-only tools (fake-cdp, rn-cdp CLI wrapper)
extensions/          "installed extensions": sample-extension/, graphql/, altair/
```

Layering rule (imports point downward only): `shared` ← `chrome-shim` ← `main/*` ←
`preload/*`. Preloads contain no policy; the shim never touches `window`/`ipcRenderer`.
`frontend/` is off this graph: its files are plain expressions `executeJavaScript`-ed
into the frontend's main world, never `require`d at runtime.

## Components

### Electron main process (`src/main/`)

- `index.js` — lifecycle wiring only (`start()` the bridge on ready, `stop()` on quit), plus
  the one place that decides **what counts as an application window**: the hidden background
  worker windows are not user-closable, so they neither keep the app alive nor block
  `activate` (see `docs/features/BACKGROUND-WORKER.md` § App shutdown).
  `window.js` — BrowserWindow + frontend load.
  `config.js` — frontend URL (`http://127.0.0.1:8081/rozenite/rn_fusebox.html?ws=localhost:9223`),
  extensions dir, CDP-bridge knobs; all env-overridable: `DEVTOOLS_FRONTEND_URL`,
  `DEVTOOLS_EXTENSIONS_DIR`, `DEVTOOLS_CDP_BRIDGE` (`off` = external relay),
  `DEVTOOLS_METRO_HOST` / `DEVTOOLS_METRO_PORT`, `DEVTOOLS_CDP_HOST` / `DEVTOOLS_CDP_PORT`,
  `DEVTOOLS_APP_FILTER` / `DEVTOOLS_DEVICE_FILTER`, `DEVTOOLS_CDP_REQUEST_TIMEOUT_MS`.
  The frontend is a patched RN
  DevTools fork ("rozenite") that renders extension panels as iframes; it is **not** in
  this repo.
- `cdp-bridge.js` — **the shell owns the RN debugger session**. Accepts the frontend's
  CDP WebSocket (the `ws` host:port from its URL), keeps the upstream socket to Metro's
  inspector proxy (target discovery via `/json/list`, re-attach loop, bounded
  reconnect buffer, `127.0.0.1` Origin), and exposes the host-side APIs
  `sendCommand(method, params) → Promise` and `onEvent(method, handler)`. Host commands
  are correlated by a reserved message-id range (`HOST_ID_BASE`), so they ride the
  frontend's own session — the app never sees a second debugger — and their replies are
  consumed in main instead of being forwarded to the frontend. Everything else relays
  verbatim. Injected transports/timers/logging (no Electron import) keep it unit-testable
  against a fake upstream (`tests/cdp-bridge.test.js`). `DEVTOOLS_CDP_BRIDGE=off` leaves
  the socket to an external relay.
- `inspected-window.js` — `chrome.devtools.inspectedWindow.eval` / `.reload` as
  `Runtime.evaluate` / `Page.reload` on that session, with the pure CDP → Chrome
  `[value, exceptionInfo]` mapping (`mapEvaluation`).
- `network-model.js` + `network-service.js` — the shell's own network model, built from the
  bridge's `Network.*` notifications (`requestWillBeSent` → `loadingFinished`/`loadingFailed`)
  with lazy single-flight `Network.enable`, a bounded record buffer, HAR 1.2 output and lazy
  `Network.getResponseBody` bodies. The service fans one message per lifecycle step out to
  the extension frames that asked for network data and serves `getHar` / `getStatus` /
  `getBody` over async IPC. No Electron, no bridge import: `sendCommand` / `onEvent` are
  injected, so the model is unit-testable without a socket.
  [features/DEVTOOLS-NETWORK.md](features/DEVTOOLS-NETWORK.md).
- `extension-server.js` — registers the privileged custom scheme **`rozenite://`**
  mapping `rozenite://<extension-id>/<path>` → `extensions/<extension-id>/<path>`,
  guarded against path traversal. **Installing an extension = dropping its unpacked
  folder into `extensions/`.** Every response carries that extension's CSP
  (`src/shared/csp.js`): its own `content_security_policy`, or Chrome's MV3 default.
  The handler is **`protocol.handle`**, not the deprecated `registerFileProtocol`, because
  one response kind has no bytes on disk: the reserved path
  `rozenite://<id>/__rozenite_background__?script=<path>&type=<classic|module>` returns a
  **synthesized bootstrap document** for an extension's background context. It has to be
  generated — the extension folder is a read-only install — and its only body content is one
  same-origin `<script src=…>`, because the CSP this server itself enforces
  (`script-src 'self'`) would refuse the inline script the alternative implies. Files are
  served through `net.fetch(pathToFileURL(…))` so Chromium picks the MIME type (a module
  script with the wrong type is a hard load failure), with the CSP header re-applied.
  Reserved paths are reserved in both directions, so a real file cannot shadow the bootstrap
  and `?script=` cannot name a file outside the extension — it goes through the same
  containment check as any other request.
- `background-host.js` — one hidden `BrowserWindow` (`show: false`) per extension that
  declares a background (`docs/features/BACKGROUND-WORKER.md`). It is **a third execution
  context**, next to the frontend's main frame and the extension iframes inside it: the
  worker's document is the main frame of its own window, so `src/preload/index.js` dispatches
  on the **protocol first** (an extension page is an extension page whether it is an iframe or
  a window's top frame) and the worker gets the same shim, gate, and `RUNTIME_REGISTER` seat
  as a panel. `did-fail-load`, `render-process-gone`, `unresponsive` and the worker's console
  are relayed with the extension id, with Electron 38's string log-levels normalized to a
  number — a level that silently reads as `log` is how a dead worker stops being reportable.
- `install-state.js` — which extension versions the host has seen (`{version, installedAt}`
  in `electron-store`, under `userData`), and therefore whether a worker's first event is
  `onInstalled{install}`, `onInstalled{update}`, or `onStartup`.
- `frame-security.js` — the one place webPreferences are decided, with the measured
  reasons for each option. `ipc.js` registers every channel and gates each call on the
  calling frame (`event.senderFrame` + `event.frameId`, pinned to the principal that
  registered it), and consults `delivery-scope.js` so a frame only receives deliveries
  its declared permissions cover.
- `message-router.js` — the runtime-messaging relay: registry of live extension frames
  (identity derived main-side from the frame itself), `sendMessage` fan-out with
  Chrome response-settling, Port lifecycle. `dispatch.js` + `context-menu.js` — the
  host→frontend dispatch channel and its first consumer.

### Security model (`src/main/frame-security.js`)

One `webPreferences` object per `WebContents`. Every extension **iframe** (devtools page,
panels) lives inside the frontend's own frame tree — `src/frontend/panel-bridge.js` creates
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
| `sandbox` | `false` | **still open**: a sandboxed preload cannot `require` this repo's preload modules, so enabling it means shipping one bundled preload file — a build step this PoC does not have |

So an extension page reaches the host only through named, validated `invoke` channels,
and each channel re-derives identity from the calling frame. The remaining gaps are
listed honestly in [LIMITATIONS.md](LIMITATIONS.md): sandbox off, one shared
`webPreferences`, and therefore a renderer compromise still being a Node compromise.

The end-to-end assertions for all of this live in `tests/extension-frame-electron.test.js`
+ `tests/extension-frame-harness.js`, which boots a production-shaped shell headlessly
(`show: false`, `DEVTOOLS_CDP_BRIDGE=off`, no Metro) — an extension frame needs neither a
device nor the frontend to be observable.

### Main-frame preload (`src/preload/frontend-host.js`)

- Implements **`InspectorFrontendHost`** — the ~60-method host interface the frontend
  expects Chrome to provide. Methods are grouped into explicit **[REAL] / [FAKE] /
  [STUB]** clusters mirroring the gap analysis:
  [api/INSPECTOR-FRONTEND-HOST.md](api/INSPECTOR-FRONTEND-HOST.md). `isHostedMode()`
  returns `true`. Bridged via `contextBridge`, merged into `window.InspectorFrontendHost`
  via `executeInMainWorld`.
- `setInjectedScriptForOrigin(origin, script)` is a documented **no-op**. It used to be the
  channel through which the frontend fork shipped a `chrome.devtools.*` implementation into
  extension frames, to be stored in main and `new Function`'d into every frame of that
  origin. `chrome.devtools.*` is now implemented shell-side in `src/chrome-shim/devtools.js`,
  so the channel, its in-memory store, and the two `sendSync` exceptions that carried it are
  all gone — which makes the async-IPC house rule in `src/shared/ipc.js` unconditional.

### Extension-iframe preload (`src/preload/extension-frame.js`)

Any iframe loaded under `rozenite:` (hostname = extension id) gets, in order — and this is
also what an extension's **background context** gets, since that is a `rozenite:` document in
a hidden window of its own:

- the **`chrome` namespace** assembled by `src/chrome-shim`, merged onto `window.chrome`
  (its `devtools.inspectedWindow.eval` / `.reload` are wired to the async `DEVTOOLS_EVAL`
  / `DEVTOOLS_RELOAD` IPC channels, answered by `src/main/inspected-window.js`; its network
  APIs are wired to `NETWORK_SUBSCRIBE` / `NETWORK_GET_HAR` / `NETWORK_GET_STATUS` /
  `NETWORK_GET_BODY`, with `NETWORK_DELIVER` as the host's push channel);
- a **permission gate** (`src/shared/permissions.js` + `src/chrome-shim/permission-gate.js`)
  seeded from the grants `RUNTIME_REGISTER` derives from the manifest **on disk** — so the
  verdict is the host's, and a page-world script cannot widen it by replacing
  `chrome.runtime.getManifest`;
- a **startup delivery queue** on `RUNTIME_DELIVER`, flushed at `DOMContentLoaded`. The host
  pushes a frame's first delivery (a lifecycle event, for a worker) the instant it registers,
  which is during preload evaluation — before the page's listeners exist. Chrome has the same
  rule for the same reason;
- nothing else. No raw `ipcRenderer`, no injected-script fetch, no Node globals: the page
  world has named channels only.

### Chrome API shim (`src/chrome-shim/`)

Pure modules; `index.js` assembles the namespace from injected deps:

- `storage.js` — real `chrome.storage.local/sync` ([REAL]), `StorageArea` contract with
  `onChanged`, quotas, promise + callback styles, against an injected backend
  (electron-store adapter wired by the preload: one JSON file per extension per area).
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
  on the shared network bridge, and inert panel events
  ([features/DEVTOOLS-PANELS.md](features/DEVTOOLS-PANELS.md)). `tabs.js` answers with the
  ONE tab this shell has — the inspected RN target, under the id
  `devtools.inspectedWindow.tabId` reports — with url/title read from the host's CDP target
  info and `create`/`remove` driving the host's own open policy.
  Full gap analysis: [api/CHROME-EXTENSION-APIS.md](api/CHROME-EXTENSION-APIS.md).

### Shell-driven extension hosting (`src/main/extensions.js`, `src/main/panel-host.js`, `src/frontend/panel-bridge.js`)

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
`--target-url` selects the tab). Lets extension behavior be developed against a web
app. Since the shell now binds the frontend's `ws` port itself, run the shell with
`DEVTOOLS_CDP_BRIDGE=off` while this proxy holds that port.

### `src/tools/rn-cdp.js` — optional external relay (`npm run rn-cdp`)

A thin CLI over `src/main/cdp-bridge.js`, for running the relay **outside** the shell.
The shell does this internally now, so the usual flow is just `npm start`. Keep it for
the external-bridge mode (`DEVTOOLS_CDP_BRIDGE=off npm start` + `npm run rn-cdp`), or
to serve the frontend from another host. Flags: `--metro-host/--metro-port`,
`--listen-port`, `--app`, `--device`.

## Data flows (current)

```
        RN app  ⇄  Metro /inspector/debug
                        ▲
                        │ upstream socket (/json/list discovery + re-attach loop)
                        ▼
   host ──► CDP BRIDGE (src/main/cdp-bridge.js) ◄──► DevTools frontend (main frame)
            │  sendCommand(method, params) → Promise     │ InspectorFrontendHost.* (preload stubs)
            │  onEvent(method, handler)                  │ setInjectedScriptForOrigin ──► no-op
            │                                            ▼
            │  ids ≥ HOST_ID_BASE: consumed here,     extension iframes  rozenite://<id>/<page>
            │  never forwarded to the frontend;       (preload: chrome shim, no Node surface)
            │  everything else relays verbatim              ▲
            │                                               │ async IPC
            ├── Runtime.evaluate / Page.reload ◄── main/inspected-window.js
            │                                       (DEVTOOLS_EVAL / DEVTOOLS_RELOAD)
            └── Network.* ◄─► main/network-model.js ──► network-service.js
                                (lazy Network.enable,      │  one delivery per lifecycle step,
                                 HAR 1.2, bodies)          ▼
                                              chrome.devtools.network + chrome.webRequest
```

One upstream session serves the frontend **and** host commands: the app never learns
about a second debugger, and the frontend never sees a command it did not send. One
`Network.enable` session likewise serves the frontend's own Network panel, Rozenite's
middleware, and every extension frame — the model accumulates once in main and fans out.

## Execution contexts, current

| Context | Where it runs | Frame tree | Created by |
| --- | --- | --- | --- |
| DevTools frontend | main frame of the visible `BrowserWindow` | its own | `window.js` |
| devtools page, panel pages | `rozenite://` iframes | **the frontend's** | `src/frontend/panel-bridge.js` |
| **background context** (MV3 worker) | main frame of a hidden `BrowserWindow`, one per extension | **its own** | `src/main/background-host.js` |
| injected content scripts | **inside the inspected app**, not in any Electron context | none — the app is not a frame tree | `src/main/content-bridge.js`, over the CDP session, only for extensions named in `DEVTOOLS_CONTENT_SCRIPTS` |

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
