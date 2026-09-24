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

- `chrome.webRequest` is **observe-only**: events are replayed from the frontend's view of
  the CDP stream; listeners can't block/modify/cancel requests; only two event kinds are
  emitted. Most listeners are empty `addListener`s.
- Response bodies are a **fake hardcoded stub** — extensions that inspect payloads only
  *appear* to work.
- `chrome.tabs.*` is an **inert shell** (`query()` → `[]`, events never fire —
  `src/chrome-shim/tabs.js`), enough for Altair's `tabs.query` consumers to render its
  monitor panel. The background worker itself does not run
  yet, so `runtime.onInstalled` has no producer ([features/BACKGROUND-WORKER.md](features/BACKGROUND-WORKER.md)).
  `runtime.sendMessage`/Ports between extension frames DO work now
  ([features/RUNTIME-MESSAGING.md](features/RUNTIME-MESSAGING.md)).
- `chrome.devtools.panels.create` is real and shell-driven
  ([features/DEVTOOLS-PANELS.md](features/DEVTOOLS-PANELS.md)); `devtools.inspectedWindow.eval`,
  `devtools.network.getHAR` etc. are inert stubs awaiting the dispatch channel.

**Host/frontend coupling**

- Depends on a **private patched RN DevTools fork** served from a Metro dev server at a
  hardcoded URL/port; nothing is packaged. Stock RN DevTools + this shell = no extension
  support.
- CDP connection fixed at `ws=localhost:9223`; `src/tools/fake-cdp.js` proxies exactly one
  Chrome tab and `src/tools/rn-cdp.js` exactly one RN app target — no multi-target/device
  multiplexing.

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
with real GraphQL tooling, but is far from a product: no lifecycle/permission model,
synthetic network data, deep coupling to an unmerged frontend fork. The path forward is
in [ROADMAP.md](ROADMAP.md); per-functionality state is in [features/README.md](features/README.md).
