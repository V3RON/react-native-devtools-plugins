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
- CDP connection fixed at `ws=localhost:9223`; `fake-cdp.js` hardcodes one Chrome URL —
  no multi-target/device support.

**Security & robustness**

- Extensions get `ipcRenderer` directly + node integration in subframes, `webSecurity:
  false`, sandbox off: any extension folder has full Node/Electron privileges. No
  isolation or permission gating.
- Injected scripts: in-memory `Map` (lost on restart), origin-keyed, evaluated via
  `new Function`, delivered over **synchronous** IPC — fragile and blocking by design.
- Leftover experimental code (`will-frame-navigate` injecting `console.log('hello')`,
  unused `index.html`/`renderer.js` boilerplate, DevTools open by default).

**Bottom line:** the proof-of-concept shows the hosting + storage + panel plumbing works
with real GraphQL tooling, but is far from a product: no lifecycle/permission model,
synthetic network data, deep coupling to an unmerged frontend fork. The path forward is
in [ROADMAP.md](ROADMAP.md); per-functionality state is in [features/README.md](features/README.md).
