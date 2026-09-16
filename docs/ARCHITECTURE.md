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
└── tools/           dev-only tools (fake-cdp)
extensions/          "installed extensions": sample-extension/, graphql/, altair/
```

Layering rule (imports point downward only): `shared` ← `chrome-shim` ← `main/*` ←
`preload/*`. Preloads contain no policy; the shim never touches `window`/`ipcRenderer`.

## Components

### Electron main process (`src/main/`)

- `index.js` — lifecycle wiring only. `window.js` — BrowserWindow + frontend load.
  `config.js` — frontend URL (`http://127.0.0.1:8081/rozenite/rn_fusebox.html?ws=localhost:9223`),
  extensions dir; env-overridable. The frontend is a patched RN DevTools fork
  ("rozenite") that renders extension panels as iframes; it is **not** in this repo.
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
- the **`chrome` namespace** assembled by `src/chrome-shim`, merged onto `window.chrome`;
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
  Full gap analysis: [api/CHROME-EXTENSION-APIS.md](api/CHROME-EXTENSION-APIS.md).

### `src/tools/fake-cdp.js` — dev convenience (`npm run fake-cdp`)

WebSocket proxy: RN DevTools frontend (expects `ws://localhost:9223`) ⇄ real Chrome tab's
CDP endpoint (port 9222, `--target-url` selects the tab). Lets extension behavior be
developed against a web app.

## Data flows (current)

```
RN app ⇄ Metro/CDP ws ⇄ DevTools frontend (main frame)
                             │  InspectorFrontendHost.* (preload stubs)
                             │  setInjectedScriptForOrigin ──► main process (in-memory map)
                             ▼
        extension iframes  rozenite://<id>/<page>   (preload: injected script + chrome shim)
                             ▲
        frontend postMessage (RequestStarted/RequestFinished) ──► chrome.webRequest listeners
```

Target status per functionality: [features/README.md](features/README.md).
