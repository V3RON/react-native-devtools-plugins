# Architecture of the current prototype

## Core insight

RN DevTools' frontend (Fusebox) **is** the Chrome DevTools frontend. So running Chrome
extensions in it "only" needs:

1. a place to host extension pages → iframes under a custom protocol,
2. a `chrome.*` API shim in those pages,
3. an `InspectorFrontendHost` stub the frontend can call on its "browser".

Electron provides all three.

## Components

### Electron shell (`main.js`)

- Loads the DevTools frontend from a Metro dev server:
  `http://127.0.0.1:8081/rozenite/rn_fusebox.html?ws=localhost:9223`. The frontend is a
  patched RN DevTools fork (codename "rozenite") that renders extension panels as iframes;
  it is **not** in this repo.
- Registers a privileged custom scheme **`rozenite://`** mapping
  `rozenite://<extension-id>/<path>` → `<repo-root>/<extension-id>/<path>`.
  **Installing an extension = dropping its unpacked folder at the repo root**
  (`sample-extension/`, `graphql/`, `altair/`).
- Keeps an in-memory `Map` of per-origin "injected scripts" (see below), exchanged over
  synchronous IPC.
- Window settings deliberately relaxed: `webSecurity: false`, `sandbox: false`,
  `nodeIntegrationInSubFrames: true`.

### Main-frame preload (`preload.js`)

- Implements **`InspectorFrontendHost`** — the ~60-method host interface the frontend
  expects Chrome to provide. Mostly no-op stubs; `isHostedMode()` returns `true`.
  Bridged via `contextBridge`, merged into `window.InspectorFrontendHost` via
  `executeInMainWorld`. Full gap analysis: [api/INSPECTOR-FRONTEND-HOST.md](api/INSPECTOR-FRONTEND-HOST.md).
- Key repurposed method: `setInjectedScriptForOrigin(origin, script)` — the frontend hands
  the host a script per origin; the preload stores it in the main process (`sendSync`).
  This is the channel the fork uses to ship its `chrome.devtools.*` implementation into
  extension frames.
- `Events.send` broadcasts `postMessage` to all iframes (frontend → extension network
  event path).

### Extension-iframe preload (non-main-frame branch of `preload.js`)

Any iframe loaded under `rozenite:` (hostname = extension id) gets:

- the stored **injected script** for its origin (fetched via IPC, evaluated with
  `new Function(script)(0)`) — this defines `chrome.devtools.panels.create` etc. so the
  extension's devtools page can register panel tabs;
- the **`chrome` namespace shim** from `chrome-runtime.js`, merged onto `window.chrome`;
- currently also a raw `ipcRenderer` exposure (security debt — see
  [LIMITATIONS.md](LIMITATIONS.md)).

### Chrome API shim (`chrome-runtime.js`)

- `chrome.storage.local/sync` — real, backed by `electron-store` (one JSON file per
  extension per area), with `onChanged`, quotas, promise + callback styles.
- `chrome.webRequest.onBeforeRequest/onBeforeSendHeaders` — fed **synthetically** from
  `RequestStarted`/`RequestFinished` postMessages relayed from the frontend.
- `chrome.runtime.onMessage` — no-op. `RequestFinished.getContent()` returns a **hardcoded
  base64 stub payload**. Full gap analysis: [api/CHROME-EXTENSION-APIS.md](api/CHROME-EXTENSION-APIS.md).

### `fake-cdp.js` — dev convenience

WebSocket proxy: RN DevTools frontend (expects `ws://localhost:9223`) ⇄ real Chrome tab's
CDP endpoint (port 9222). Lets extension behavior be developed against a web app.
Commented-out code fakes `ReactNativeApplication.metadataUpdated` to spoof an RN device.

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
