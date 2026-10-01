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

- `index.js` — lifecycle wiring only. `window.js` — BrowserWindow + frontend load.
  `config.js` — frontend URL (`http://127.0.0.1:8081/rozenite/rn_fusebox.html?ws=localhost:9223`),
  extensions dir, CDP-bridge knobs; all env-overridable. The frontend is a patched RN
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
- `extension-server.js` — registers the privileged custom scheme **`rozenite://`**
  mapping `rozenite://<extension-id>/<path>` → `extensions/<extension-id>/<path>`,
  guarded against path traversal. **Installing an extension = dropping its unpacked
  folder into `extensions/`.**
- `injected-scripts.js` + `ipc.js` — in-memory per-origin "injected script" store
  exchanged over synchronous IPC.
- `message-router.js` — the runtime-messaging relay: registry of live extension frames
  (identity derived main-side from the frame itself), `sendMessage` fan-out with
  Chrome response-settling, Port lifecycle. `dispatch.js` + `context-menu.js` — the
  host→frontend dispatch channel and its first consumer.
- Window settings deliberately relaxed: `webSecurity: false`, `sandbox: false`,
  `nodeIntegrationInSubFrames: true`.

### Main-frame preload (`src/preload/frontend-host.js`)

- Implements **`InspectorFrontendHost`** — the ~60-method host interface the frontend
  expects Chrome to provide. Methods are grouped into explicit **[REAL] / [FAKE] /
  [STUB]** clusters mirroring the gap analysis:
  [api/INSPECTOR-FRONTEND-HOST.md](api/INSPECTOR-FRONTEND-HOST.md). `isHostedMode()`
  returns `true`. Bridged via `contextBridge`, merged into `window.InspectorFrontendHost`
  via `executeInMainWorld`.
- Key repurposed method: `setInjectedScriptForOrigin(origin, script)` — the frontend hands
  the host a script per origin; stored in the main process (`sendSync`). This is the
  channel the fork uses to ship its `chrome.devtools.*` implementation into extension frames.
- `Events.send` broadcasts `postMessage` to all iframes ([FAKE] frontend → extension
  network event transport).

### Extension-iframe preload (`src/preload/extension-frame.js`)

Any iframe loaded under `rozenite:` (hostname = extension id) gets, in order:

- the stored **injected script** for its origin (fetched via IPC, evaluated with
  `new Function(script)(0)`) — this defines `chrome.devtools.panels.create` etc. so the
  extension's devtools page can register panel tabs;
- the **`chrome` namespace** assembled by `src/chrome-shim`, merged onto `window.chrome`
  (its `devtools.inspectedWindow.eval` / `.reload` are wired to the async `DEVTOOLS_EVAL`
  / `DEVTOOLS_RELOAD` IPC channels, answered by `src/main/inspected-window.js`);
- currently also a raw `ipcRenderer` exposure (security debt — see
  [LIMITATIONS.md](LIMITATIONS.md)).

### Chrome API shim (`src/chrome-shim/`)

Pure modules; `index.js` assembles the namespace from injected deps:

- `storage.js` — real `chrome.storage.local/sync` ([REAL]), `StorageArea` contract with
  `onChanged`, quotas, promise + callback styles, against an injected backend
  (electron-store adapter wired by the preload: one JSON file per extension per area).
- `network-bridge.js` — maps inbound `RequestStarted`/`RequestFinished` events
  ([FAKE] synthetic feed from the frontend) onto `chrome.webRequest` listeners;
  finished requests get a **hardcoded base64 stub body** via an injected dep.
- `runtime.js` + `messaging.js` — identity (`id`/`getURL`/`getManifest`/platform) and
  real `sendMessage`/Ports, relayed by the host message router
  ([REAL, extension-scoped]; lifecycle events await the background host).
  `event.js` provides Chrome-semantics Event objects shared across the shim.
- `devtools.js` — `chrome.devtools.*`: real `panels.create` (host-driven tabs), real
  `inspectedWindow.eval` against an injected `evalInPage` host dependency
  ([features/INSPECTED-WINDOW.md](features/INSPECTED-WINDOW.md)), inert network/panels
  events ([features/DEVTOOLS-PANELS.md](features/DEVTOOLS-PANELS.md)); `tabs.js` — inert
  `chrome.tabs` shell. Full gap analysis: [api/CHROME-EXTENSION-APIS.md](api/CHROME-EXTENSION-APIS.md).

### Shell-driven extension hosting (`src/main/extensions.js`, `src/main/panel-host.js`, `src/frontend/panel-bridge.js`)

Replaces hardcoded fork knowledge end-to-end
([features/DEVTOOLS-PANELS.md](features/DEVTOOLS-PANELS.md)): `extensions.js` scans
`extensionsDir` and parses manifests; `panel-host.js` evaluates the bridge into the
frontend on every load (after `.main-tabbed-pane` appears) and owns the live panel
registry; the bridge imports the frontend's own `ui/legacy/legacy.js` (same module
instance, same `InspectorView` singleton), spawns hidden devtools-page iframes, and
turns `chrome.devtools.panels.create` IPCs into real tabs (`SimpleView` + iframe).
Devtools-side API surface lives in `chrome-shim/devtools.js` (panels/inspectedWindow/
network per the stubbing rule) plus the inert `chrome-shim/tabs.js` shell.

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
                                    ▲  upstream socket (discovery + re-attach loop)
                                    │
   host: sendCommand(method, params)│   CDP BRIDGE   ⇄   DevTools frontend (main frame)
         onEvent(method, handler) ──┤   (src/main/       │ InspectorFrontendHost.* (preload stubs)
   ids >= HOST_ID_BASE are consumed      cdp-bridge.js)  │ setInjectedScriptForOrigin ──► main map
   here and never forwarded;          │                   ▼
   everything else relays verbatim ───┘   extension iframes  rozenite://<id>/<page>
                                          (preload: injected script + chrome shim)
   main/inspected-window.js ◄── DEVTOOLS_EVAL IPC from an extension frame
   = sendCommand("Runtime.evaluate")        ▲
                                    chrome.devtools.inspectedWindow.eval

   [FAKE, still] frontend postMessage (RequestStarted/RequestFinished)
             ──► chrome.webRequest listeners → to be replaced by the bridge's
                 onEvent("Network.*")
```

One upstream session serves the frontend **and** host commands: the app never learns
about a second debugger, and the frontend never sees a command it did not send.

Target status per functionality: [features/README.md](features/README.md).
