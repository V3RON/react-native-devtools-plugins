# Host→frontend dispatch channel (`InspectorFrontendAPI` / `events` / `sendMessageToBackend`)

| | |
| --- | --- |
| **Status** | ❌ missing — the biggest architectural gap |
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

`preload.js` sets `events: null` and implements only the call direction.
`sendMessageToBackend` is a no-op. The host can therefore **never** tell the frontend
anything — no menu selections, no panel switching, no theme changes, no backend message
proxying. All synthetic extension data today flows through an ad-hoc `Events`
postMessage hack that only carries two fake network events.

## Plan

1. Preload listens on IPC and calls `InspectorFrontendAPI.<event>(...)` — the frontend
   always defines this global; upstream `EventDescriptors`
   (`front_end/core/host/InspectorFrontendHostAPI.ts`) is the authoritative event list.
2. Wire `sendMessageToBackend` → the CDP socket the frontend owns (or proxy via main),
   including `dispatchMessage`/`dispatchMessageChunk` for host-originated messages.
3. Replace the `Events` postMessage bridge: network events for
   [devtools-network](DEVTOOLS-NETWORK.md)/[webRequest](WEBREQUEST.md) become a consumer
   of this channel, not a parallel transport.
4. Async-only IPC everywhere (kill `sendSync` usage — see
   [../LIMITATIONS.md](../LIMITATIONS.md)).

## Definition of done

Frontend dispatches `showPanel` and `contextMenuItemSelected` round-trips through the
host; a real CDP command from an extension reaches the RN backend through
`sendMessageToBackend` and its reply comes back.
