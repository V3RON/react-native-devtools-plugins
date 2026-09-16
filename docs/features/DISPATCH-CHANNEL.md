# Host→frontend dispatch channel (`InspectorFrontendAPI` / `events` / `sendMessageToBackend`)

| | |
| --- | --- |
| **Status** | 🟨 partial — channel live; backend messaging pending |
| **Tier** | 1 (infrastructure; unblocks most of Tier 1/2) |
| **Blocks** | devtools-network, panels events/theme/context menus, webRequest, save flow, eye-dropper, device discovery |

## What Chrome does

`InspectorFrontendHost` is only the frontend→host direction. The host talks **back** by
dispatching events: the frontend exposes a global `InspectorFrontendAPI` whose methods
(`dispatchMessage`, `dispatchMessageChunk`, `showPanel`, `setInspectedTabId`,
`contextMenuItemSelected`, `savedURL`, `revealSourceLine`, `keyEventUnhandled`,
`colorThemeChanged`, `reloadInspectedPage`, device events, …) fire into
`InspectorFrontendHost.events` (upstream `EventDescriptors` defines the full table).
`InspectorFrontendHost.sendMessageToBackend(message)` is the frontend→backend CDP escape
hatch on the other side.

## Current state here

**The channel is live** (`src/main/dispatch.js` → `HOST_EVENT` IPC → main-frame
preload → `window.InspectorFrontendAPI[name](...args)` in the frontend's main
world). Main process calls `dispatchToFrontend(eventName, args)`; the preload
warns-and-drops events raised before the frontend defined its API object
(same as Chrome, which only dispatches once the frontend is up).

First round-trip consumer: **context menus**. `showContextMenuAtPoint` builds a
native Electron `Menu` from the `ContextMenuDescriptor[]` (pure mapping in
`src/main/context-menu.js`, unit-tested) and pops it; the selection returns as
`contextMenuItemSelected(id)` and close as `contextMenuCleared`.

Also landed with it: async-only IPC for everything new (`invoke`/`handle` —
`src/shared/ipc.js` house rule), and preferences/zoom/window ops now REAL.

Still missing:

- `sendMessageToBackend` remains a labeled no-op — the response contract
  (`dispatchMessage`/`dispatchMessageChunk` wrapping) is fork-specific and must
  be verified against the real "rozenite" frontend before wiring a CDP bridge.
- The `Events` postMessage hack still carries the two synthetic network events;
  its consumers (devtools-network/webRequest) should move onto this channel.
- No producer yet for `showPanel`/`colorThemeChanged`/etc. — they only become
  meaningful as extension APIs grow.

## Plan

1. ~~Preload listens on IPC and calls `InspectorFrontendAPI.<event>(...)~~ ✅ done.
2. ~~Async-only IPC for new channels~~ ✅ done (injected-script `sendSync` kept
   deliberately — it must run before page scripts; see `src/shared/ipc.js`).
3. Wire `sendMessageToBackend` → the CDP socket the frontend owns (or proxy via
   main), including `dispatchMessage`/`dispatchMessageChunk` — **needs the real
   fork to pin down semantics**.
4. Replace the `Events` postMessage bridge: network events for
   [devtools-network](DEVTOOLS-NETWORK.md)/[webRequest](WEBREQUEST.md) become a consumer
   of this channel, not a parallel transport.

## Definition of done

Frontend dispatches `showPanel` and `contextMenuItemSelected` round-trips through the
host; a real CDP command from an extension reaches the RN backend through
`sendMessageToBackend` and its reply comes back.

*Progress:* `contextMenuItemSelected` round-trip implemented (awaiting manual
verification against the running fork); `showPanel` producer and the
`sendMessageToBackend` round-trip remain.
