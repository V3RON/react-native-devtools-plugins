# Refactoring plan

Goal: restructure the prototype into properly encapsulated modules — one level of
abstraction per layer — as the precondition for everything in
[ROADMAP.md](ROADMAP.md). Behavior stays identical throughout; each step is verified by
`npm start` + GraphQL Network Inspector / Altair still loading their panels.

## Problems in the current code

1. `main.js` mixes five layers: app lifecycle, window creation, injected-script state,
   IPC transport, extension file serving; plus hardcoded frontend URL and dead
   experimental code (`will-frame-navigate` injection experiment, `openDevTools()`,
   unused imports).
2. `preload.js` is two programs in one file (main-frame host stub vs extension-frame
   shim, branched by a top-level `return`), with a 200-line inline `InspectorFrontendHost`
   literal that doesn't distinguish real impls from fakes from stubs.
3. `chrome-runtime.js` entangles pure `chrome.*` shim logic with transport
   (`window.addEventListener("message")`) and test data (hardcoded response body).
   No dependency injection → untestable; the future dispatch channel has no seam to plug into.
4. Dead/broken code: `index.html`, `renderer.js`; preload debug methods invoke IPC
   handlers (`get-all-injected-scripts`, `get-all-origins`, `clear-injected-scripts`)
   that **were never registered in main** — they would throw.
5. Hidden shared contracts: IPC channel names duplicated as string literals across
   processes; `rozenite` scheme name scattered in 3 files; "extension id == repo-root
   folder name" is an implicit, undocumented contract.
6. `getStorage()` runs in *every* extension iframe preload → multiple `electron-store`
   instances writing the same JSON file → lost-write races. State ownership sits in the
   wrong process.
7. `fake-cdp.js` at repo root with hardcoded target URL/port.
8. Path traversal hole: protocol does `path.join(root, extensionId, innerPath)`
   unguarded — `rozenite://x/../../<secret>` escapes the extension dir.

## Target layout

```
src/
├── shared/                    # contracts only, no behavior
│   ├── ipc.js                 # channel name constants + payload shapes (single source)
│   └── protocol.js            # scheme constant; URL <-> (extensionId, path) helpers
├── main/                      # Electron main process — owns all persistent state
│   ├── index.js               # bootstrap/lifecycle wiring only (~30 lines)
│   ├── window.js              # BrowserWindow creation + frontend loadURL
│   ├── config.js              # frontend URL, ws address, extensions dir; env overrides
│   ├── injected-scripts.js    # per-origin script store (main-owned state)
│   ├── ipc.js                 # IPC handler registration; delegates to services
│   └── extension-server.js    # protocol registration, extensions/<id> resolution,
│                              #   traversal guard; future manifest parsing lives here
├── preload/                   # thin transport layer — no policy, no state
│   ├── index.js               # dispatch: isMainFrame → frontend-host;
│   │                          #   rozenite: frame → extension-frame
│   ├── frontend-host.js       # InspectorFrontendHost, organized into explicit
│   │                          #   REAL / FAKE / STUB clusters (maps to roadmap buckets)
│   └── extension-frame.js     # fetch injected script, install chrome shim, Events bridge
├── chrome-shim/               # PURE logic; runs in any JS realm; deps injected
│   ├── index.js               # createChromeNamespace({ extensionId, storage, networkBus })
│   ├── storage.js             # createStorageArea(backend) — StorageBackend interface
│   └── network-bridge.js      # inbound events → webRequest listeners (no window ref)
└── tools/
    └── fake-cdp.js            # dev tool; CLI flags/env instead of hardcoded values
extensions/                    # "installed extensions" (moved from repo root)
├── sample-extension/
├── graphql/
└── altair/
```

Layering (imports point downward only):
`shared` ← `chrome-shim` (pure) ← `main/*` (state + services) ← `preload/*` (transport).
Preloads contain no logic; `chrome-shim` never touches `window`/`ipcRenderer` —
transports are injected. This is also the seam where the
[dispatch channel](features/DISPATCH-CHANNEL.md) lands.

## Decisions

- **CommonJS** everywhere (preload-friendly, no bundler for a PoC).
- `InspectorFrontendHost` methods grouped **real / fake / stub** with comments referencing
  [api/INSPECTOR-FRONTEND-HOST.md](api/INSPECTOR-FRONTEND-HOST.md) rows — code layout
  mirrors the status table until we can generate from the upstream stub.
- `StorageBackend` interface isolates `electron-store`; fixes the multi-instance race
  later by swapping in a main-process-backed backend without touching shim code.
- Extensions move to `extensions/`: protocol maps `rozenite://<id>/<path>` →
  `extensions/<id>/<path>`, rejecting paths that escape the extension root
  (resolve + `startsWith` check) and invalid ids.
- Delete: `index.html`, `renderer.js`, frame-navigation experiment, broken debug methods,
  auto-opened DevTools.
- `package.json`: `"main": "src/main/index.js"`, `scripts.start = electron .`,
  `scripts.fake-cdp = node src/tools/fake-cdp.js`.

## Migration order (each step = one commit, behavior-preserving)

1. **Purge dead code + extract `src/shared/` + `main/config.js`** (URL, scheme, channels).
2. **Decompose `main/`**: window.js, injected-scripts.js, ipc.js, extension-server.js
   (+ traversal guard).
3. **Split `preload/`** into index / frontend-host / extension-frame; host methods
   re-grouped with REAL/FAKE/STUB annotations.
4. **Extract `chrome-shim/`** with dependency injection; wire real transports at the
   preload edge only.
5. **Move extensions to `extensions/`** + protocol update + README/docs paths.
6. **`tools/fake-cdp.js`** with flags; final doc/link sweep.

## Out of scope here (tracked elsewhere)

- Async IPC / killing `sendSync` + `new Function` + exposed `ipcRenderer`
  → security work in [ROADMAP.md](ROADMAP.md) guardrails (worth pairing with step 3/4).
- Any behavior change (dispatch channel, real storage backend, manifest parsing).
