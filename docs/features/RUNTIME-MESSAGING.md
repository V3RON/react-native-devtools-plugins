# Runtime messaging (`chrome.runtime`, Ports, event contract)

| | |
| --- | --- |
| **Status** | 🟨 live — surface + `sendMessage` + Ports + a background peer + `onInstalled`/`onStartup`; no Port transferables, no external messaging |
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
  `getPackages`, inert `openOptionsPage`/`requestUpdate`/`reload`/`getBackgroundPage`
  (`getBackgroundPage` is `undefined` here **and** in Chrome for an MV3 extension — a
  service worker has no page object to return).
- **Router**: `src/main/message-router.js` (relay logic) + `src/main/ipc.js`
  (frame registry). Extension frames register on load; frame identity is main-derived
  (`event.senderFrame` + `event.frameId`) with a principal check — a frame cannot claim
  another frame's key or extension id. Frames leaving mid-flight settle their legs.
- **Peers and the sender model**: every router peer is a registered *frame*, whatever
  window it lives in. Panels and devtools pages are iframes in the frontend's frame tree;
  an extension's **background context is a peer like any other**, sitting in its own hidden
  `BrowserWindow` (`src/main/background-host.js`) and registering through the same
  `RUNTIME_REGISTER`. So a panel ⇄ worker round-trip crosses two `WebContents` and needs no
  special case in the router — which is why the peer's `sender.url` is the honest way to tell
  a worker's answer from a sibling iframe's. `sender` is `{id, url}`, built by main from the
  frame it verified, never from payload.
- **`sendMessage`**: extension-scoped fan-out; promise AND callback forms; response
  settles when all target legs conclude, last valid response wins (Chrome parity).
- **Ports**: `connect()` returns a Port synchronously; ordered `postMessage` both
  ways; `disconnect()`; `onDisconnect` on peer death (lastError snapshot).
- **Lifecycle**: `onInstalled` (`install` / `update`) and `onStartup` now have a producer —
  `src/main/install-state.js` remembers `{version, installedAt}` per extension id and
  `background-host.js` delivers the verdict to the worker frame as a `kind: "lifecycle"`
  payload on this same `RUNTIME_DELIVER` channel, through the frame's own registered `send`.
  No new channel, no privileged route to the worker. Details and the rejected hosting route:
  [BACKGROUND-WORKER.md](BACKGROUND-WORKER.md).
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
- `storage.session` is per-frame in-memory, not extension-wide. This now has a real
  consequence, because the worker is a second context that wants to talk to a panel through
  it: [STORAGE-AND-I18N.md](STORAGE-AND-I18N.md) states it precisely.
- `onDisconnect`'s `lastError` is a snapshot set before the event, not a live property.
- **Host pushes can arrive before the page's listeners exist.** The host sends a frame its
  first delivery the moment it registers, which happens during preload evaluation — strictly
  before the page's own scripts run. `src/preload/extension-frame.js` therefore queues
  `RUNTIME_DELIVER` until `DOMContentLoaded` and flushes in order. Chrome has the same rule
  (no runtime event reaches a worker before its initial script has finished evaluating,
  because the listener does not exist yet); here it is a queue with a backstop timer rather
  than a scheduler, so an ordering guarantee across a document that never finishes parsing
  is not claimed.

Remaining:

1. ~~Background host~~ ✅ [BACKGROUND-WORKER.md](BACKGROUND-WORKER.md): messaging now has
   its most important peer, and `onInstalled`/`onStartup` fire.
2. Port transferables / structured clone if a real extension needs them.
3. Legacy `chrome.extension` aliases as thin delegates — deliberately still absent: the
   aliases' main uses (`getViews`, `getBackgroundPage`) have no honest answer here, so
   installing the namespace would only invent one.
4. ~~Retire the raw `ipcRenderer` exposure~~ ✅ done with the rest of issue #6.
5. Cross-frame `storage.onChanged` (the router already has the fan-out this needs).

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
      ([BACKGROUND-WORKER.md](BACKGROUND-WORKER.md)). ✅ same shim, same preload, same gate
3. Legacy `chrome.extension` aliases as thin delegates. ⛔ deliberately absent (see Remaining)

## Definition of done

Panel ⇄ background round-trip via `sendMessage` (promise + callback) and a long-lived
Port with ordered delivery, between two frames of the same extension.

**Met.** `tests/background-worker-electron.test.js` proves the panel ⇄ **worker** pair headless
in a real Electron process: `sendMessage` round-trips and the answer's `sender`/`url` is the
worker's bootstrap document (so the peer demonstrably was the worker, not a sibling iframe),
and a Port round-trips both ways. Both used through the ordinary `RUNTIME_REGISTER` path —
the worker has no special route. The promise form is the one asserted across the worker
boundary; the callback form is asserted between panel frames
(`sample-extension/panel.html`), and both share the same client code path.

*Progress:* the round-trips were first proven between two panel frames (panel ⇄ peer iframe) —
`sample-extension` exercises exactly this, and in a headless real-Electron run rather
than only by hand (`tests/extension-frame-electron.test.js`).

*Fixed while proving it:* main addressed frames with
`webContents.sendToFrame([webContents.id, event.frameId], …)`, but that tuple is read as
`[processId, routingId]`. When the extension frame lands in its own renderer process the
call delivered **nothing and threw nothing**, so every `sendMessage`/Port delivery to that
frame was silently dropped. The earlier "proven between two panel frames" claim held only
for frames sharing a process. Deliveries now go through `WebFrameMain.send` on the object the
principal check already verified (`src/main/ipc.js`), asserted in `tests/messaging-frames.test.js`.
