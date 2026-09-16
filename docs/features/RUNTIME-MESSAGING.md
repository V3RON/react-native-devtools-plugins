# Runtime messaging (`chrome.runtime`, Ports, event contract)

| | |
| --- | --- |
| **Status** | 🟡 stub — `onMessage.addListener` is a no-op; no Ports |
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

`src/chrome-shim`: `runtime.onMessage.addListener: () => {}`, `lastError: null`. No
`id`, no `getURL`, no `sendMessage`, no `connect`. (The only cross-frame plumbing is the
ad-hoc `Events` postMessage bridge used for fake network events.)

## Plan

1. Host-side message router in the Electron main process: every extension frame
   (devtools page, panels, background, injected content-bridge) registers
   `(extensionId, frameId, kind)`; host relays `sendMessage`/Port traffic between them.
2. **The cross-cutting contract rules matter more than any missing namespace** — these are
   what actually break real extensions:
   1. Promise **and** callback dual style on every async method;
   2. `runtime.lastError` set (only) inside error callbacks — extensions branch on it;
   3. real Event objects: `addListener` dedupe, `removeListener` identity semantics,
      `hasListener`, `hasListeners` — feature detection uses these;
   4. Port messaging with structured cloning (Electron `MessageChannelMain` or a JSON +
      transferable-subset encoding at the contextBridge boundary);
   5. `runtime.getURL(p)` → `rozenite://<id>/<p>` — Altair regex-parses this to derive
      the extension id, so hostname == id must hold;
   6. `chrome.*` must exist in the background context too
      ([BACKGROUND-WORKER.md](BACKGROUND-WORKER.md)).
3. Legacy `chrome.extension` aliases as thin delegates.

## Definition of done

Panel ⇄ background round-trip via `sendMessage` (promise + callback) and a long-lived
Port with ordered delivery, between two frames of the same extension.
