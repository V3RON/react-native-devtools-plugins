# Limitations of the current prototype

**Extension model**

- No extension management: no manifest parsing, install/uninstall, enumeration, or reload.
  Folders must live in `extensions/`, and the frontend fork must know about them (the
  extension list is effectively hardcoded into the fork).
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
- `chrome.runtime.onMessage` is a no-op → extension messaging is broken. Altair calls
  `chrome.tabs.*` / `chrome.storage.session` / `chrome.runtime.getURL`, which the shim
  lacks (the bundled Altair copy has local patches, e.g. `tabs.js` derives the extension
  id by regex-parsing `runtime.getURL`).
- `chrome.devtools.inspectedWindow.eval`, `devtools.network.getHAR`, etc. are absent
  (partially depends on the frontend fork's injected script).

**Host/frontend coupling**

- Depends on a **private patched RN DevTools fork** served from a Metro dev server at a
  hardcoded URL/port; nothing is packaged. Stock RN DevTools + this shell = no extension
  support.
- CDP connection fixed at `ws=localhost:9223`; `src/tools/fake-cdp.js` proxies exactly one
  Chrome tab — no multi-target/device support.

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
