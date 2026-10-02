# DevTools network (`chrome.devtools.network`)

| | |
| --- | --- |
| **Status** | 🟡 stub — synthetic events with fake bodies |
| **Tier** | 1 |
| **Blocked by** | fidelity capped by RN network inspection (the CDP transport exists: [src/main/cdp-bridge.js](../../src/main/cdp-bridge.js)) |

## Chrome surface

- `devtools.network.onRequestFinished(listener)` — listener receives a `Request` object:
  `getContent(cb)`, `getRequestContent(cb)`, `getHarEntry()`
- `devtools.network.onNavigated`
- `devtools.network.getHAR(cb)`, `getResponseBody(request, cb)`
- `devtools.panels.network.getHAR` (same underlying model)

This is what every GraphQL/REST/API inspector extension consumes. It is **the** reason
GraphQL Network Inspector and Altair exist as DevTools extensions.

## Current state here

`src/chrome-shim` fabricates `RequestFinished` from `postMessage` events the frontend
broadcasts, and `getContent()` returns a **hardcoded base64 Rick & Morty payload** —
extensions only *appear* to work. `getHAR`/`getResponseBody`/`onNavigated` absent.

## Transport is ready: the CDP bridge

The missing plumbing no longer is missing. `src/main/cdp-bridge.js` owns the RN debugger
session and exposes `onEvent("Network.*", handler)` and
`sendCommand("Network.getResponseBody", …)` to the host, multiplexed onto the frontend's
own session by message id. This work is now purely about the RN backend's actual network
fidelity and the shim/IPC surface on top of that API — not about reaching the socket.

**Read before designing on top of it** (from the RN sources; none of it observed on a
device here, so probe first — details in
[INSPECTED-WINDOW.md](INSPECTED-WINDOW.md#open-risk-for-the-next-layer-devtoolsnetwork)):

- `Network.enable` is refused with an **error** when the app has more than one registered
  RN host (`HostAgent.cpp:150`), and `emitSystemStateChanged` emits a `Network.disable`
  notification when that count changes. That count is about *hosts in the app*, not
  debugger sessions — so the bridge is not the trigger, but a multi-root app could be.
- `NetworkHandler` (`network/NetworkHandler.cpp:40`) supports several enabled agents and
  broadcasts to all of them, so a second `Network.enable` caller does not starve the
  frontend's own Network panel — it just doubles the event traffic on one socket.
- Network inspection is gated by `InspectorFlags::getNetworkInspectionEnabled()` =
  `enableBridgelessArchitecture() && fuseboxNetworkInspectionEnabled()`, and Metro's
  `enableNetworkInspector` experiment (which adds `unstable_enableNetworkPanel=true` to
  the frontend URL, `getDevToolsFrontendUrl.js:24`) defaults to `false`. With
  `DEVTOOLS_FRONTEND_URL` pointed at Rozenite's own `rn_fusebox.html`, whether that flag
  is on for our frontend is **unverified** — the whole feature can be off on both sides.

## RN mapping

Per [../OVERVIEW.md](../OVERVIEW.md#the-crux-what-inspected-window-and-network-mean-for-react-native):
the frontend already holds a real network model **if** the RN runtime reports CDP
`Network.*` events (opt-in; traffic can bypass the inspected runtime). Honest fidelity
ceiling: good for JS-thread `fetch`/`XHR` when network inspection is on; blind to native
side otherwise.

## Plan

1. ~~Ride the dispatch channel (frontend relays)~~ → superseded: the frontend does not
   expose a relay API, and the shell now sees every `Network.*` message itself. **Build
   the model in main** from `onEvent("Network.*")` on the bridge, with
   `sendCommand("Network.getResponseBody", {requestId})` for bodies, and replay
   `Network.enable` state so late-joining extensions get the accumulated history.
2. `Request` object with real `getContent/getRequestContent/getHarEntry`; `getHAR` built
   from the accumulated model; a new async IPC channel feeds it to extension frames
   (same shape as `DEVTOOLS_EVAL`).
3. `onNavigated`: map to target attach/reload or omit (document).
4. Replace the `Events` postMessage transport and the fake body in
   `src/preload/extension-frame.js`.
5. Degrade visibly when network inspection is unavailable (extensions should show "no
   network data" rather than silence) — the bridge already surfaces a `Network.enable`
   error rejection, so propagate it instead of swallowing it.

## Definition of done

GraphQL Network Inspector shows real requests, headers, and JSON bodies from a running RN
app, end-to-end, no stubbed data.
