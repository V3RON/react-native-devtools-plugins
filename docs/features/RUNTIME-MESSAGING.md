# Runtime messaging (`chrome.runtime`, Ports, event contract)

| | |
| --- | --- |
| **Status** | 🟨 partial — surface + `sendMessage` + Ports live; background/lifecycle pending |
| **Tier** | 1 |
| **Blocked by** | — (pure Electron IPC work) |

## Chrome surface

- `runtime.id`, `getURL(path)`, `getManifest()`, `sendMessage(msg, cb?)`,
  `connect({name}) → Port` (`postMessage`, `onMessage`, `onDisconnect`, structured-clone
  payloads incl. transferables), `onMessage`, `lastError`, `reload`, `openOptionsPage`,
  `getBackgroundPage`, lifecycle events (`onInstalled`, `onStartup`,
  `onUpdateAvailable`); omitted: `requestUpdate`, `connectNative`,
  `sendMessageExternal` ([TIER3-OMITTED.md](TIER3-OMITTED.md)).
- Legacy `chrome.extension` aliases: `getURL`, `getViews`, `getBackgroundPage`, `lastError`.

## Why it's load-bearing

Panel pages ⇄ devtools page ⇄ background worker ⇄ injected content scripts **all** talk
through `runtime`. Redux DevTools and friends only work over Ports. Without real
messaging, extensions are islands.

## Current state here

**Live** (verified by `npm test` — `tests/messaging.test.js` runs router + client
against each other, and `sample-extension/panel.html` runs the same checks against
the real host inside the app):

- **Surface**: `id`, `getURL` (→ `rozenite://<id>/<path>`, hostname == id holds),
  `getManifest` (host reads `manifest.json`, id from the frame URL), `getPlatformInfo`,
  `getPackages`, inert `openOptionsPage`/`requestUpdate`/`reload`/`getBackgroundPage`.
- **Router**: `src/main/message-router.js` (relay logic) + `src/main/ipc.js`
  (frame registry). Extension frames register on load; frame identity is main-derived
  (`event.senderFrame` + `event.frameId`) with a principal check — a frame cannot claim
  another frame's key or extension id. Frames leaving mid-flight settle their legs.
- **`sendMessage`**: extension-scoped fan-out; promise AND callback forms; response
  settles when all target legs conclude, last valid response wins (Chrome parity).
- **Ports**: `connect()` returns a Port synchronously; ordered `postMessage` both
  ways; `disconnect()`; `onDisconnect` on peer death (lastError snapshot).
- **Cross-cutting rules honored**: Chrome-style `Event` objects (`src/chrome-shim/event.js`:
  dedupe, identity removal, `hasListener`/`hasListeners`) now used by runtime,
  storage and storage.onChanged; scoped `lastError` via live getter re-established
  across the contextBridge; dual promise/callback style throughout.

Known deviations (deliberate, PoC):

- **Event `hasListener(fn)` does not work from page code.** The `chrome` namespace is
  published with `contextBridge.exposeInMainWorld`, which *clones* functions, so the
  callback the page passes to `addListener` is not the identity the shim stores and
  `hasListener` reports false for it in every state (measured on Electron 38).
  `addListener` dedupe, `removeListener` and `hasListener` are all real *inside* the
  shim — this is purely the world boundary. `hasListeners()` needs no identity and is
  the observable from page code; that is what the end-to-end security test asserts
  (`tests/extension-frame-electron.test.js`). Fixing it properly means either
  per-callback wrapper handles or a bundled sandboxed preload, neither of which this
  PoC has.
- Port payloads are JSON-only (no structured-clone transferables through contextBridge yet).
- `sender` carries `{id, url}` — no `tab`/`frame` objects until tabs shims exist.
- `storage.session` is per-frame in-memory, not extension-wide (Altair only uses it
  from one context today).
- `onDisconnect`'s `lastError` is a snapshot set before the event, not a live property.
- Lifecycle events (`onInstalled`/`onStartup`) are registrable but have no producer
  until the background host exists.

Remaining:

1. **Background host** (tracked in [BACKGROUND-WORKER.md](BACKGROUND-WORKER.md)):
   gives messaging its most important peer and fires `onInstalled`/`onStartup`.
2. Port transferables / structured clone if a real extension needs them.
3. Legacy `chrome.extension` aliases as thin delegates.
4. Retire the raw `ipcRenderer` exposure: with the router's validated channels in
   place, extension frames no longer need Node-level IPC ([../LIMITATIONS.md](../LIMITATIONS.md)).

## Plan (original, with progress)

1. Host-side message router in the Electron main process: every extension frame
   (devtools page, panels, background, injected content-bridge) registers
   `(extensionId, frameId, kind)`; host relays `sendMessage`/Port traffic between them. ✅
2. **The cross-cutting contract rules matter more than any missing namespace** — these are
   what actually break real extensions:
   1. Promise **and** callback dual style on every async method; ✅
   2. `runtime.lastError` set (only) inside error callbacks — extensions branch on it; ✅
   3. real Event objects: `addListener` dedupe, `removeListener` identity semantics,
      `hasListener`, `hasListeners` — feature detection uses these; ✅
   4. Port messaging with structured cloning (Electron `MessageChannelMain` or a JSON +
      transferable-subset encoding at the contextBridge boundary); 🟨 JSON-only
   5. `runtime.getURL(p)` → `rozenite://<id>/<p>` — Altair regex-parses this to derive
      the extension id, so hostname == id must hold; ✅
   6. `chrome.*` must exist in the background context too
      ([BACKGROUND-WORKER.md](BACKGROUND-WORKER.md)). ⛔ needs background host
3. Legacy `chrome.extension` aliases as thin delegates. ⛔

## Definition of done

Panel ⇄ background round-trip via `sendMessage` (promise + callback) and a long-lived
Port with ordered delivery, between two frames of the same extension.

*Progress:* the round-trips are proven between two panel frames (panel ⇄ peer iframe) —
`sample-extension` exercises exactly this, and now in a headless real-Electron run rather
than only by hand (`tests/extension-frame-electron.test.js`). The "background" qualifier
needs the background host; the transport itself doesn't care which kind a frame is.

*Fixed while proving it:* main addressed frames with
`webContents.sendToFrame([webContents.id, event.frameId], …)`, but that tuple is read as
`[processId, routingId]`. When the extension frame lands in its own renderer process the
call delivered **nothing and threw nothing**, so every `sendMessage`/Port delivery to that
frame was silently dropped. The earlier "proven between two panel frames" claim held only
for frames sharing a process. Deliveries now go through `WebFrameMain.send` on the object the
principal check already verified (`src/main/ipc.js`), asserted in `tests/messaging-frames.test.js`.
