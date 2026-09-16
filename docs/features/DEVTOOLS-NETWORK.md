# DevTools network (`chrome.devtools.network`)

| | |
| --- | --- |
| **Status** | 🟡 stub — synthetic events with fake bodies |
| **Tier** | 1 |
| **Blocked by** | [DISPATCH-CHANNEL.md](DISPATCH-CHANNEL.md); fidelity capped by RN network inspection |

## Chrome surface

- `devtools.network.onRequestFinished(listener)` — listener receives a `Request` object:
  `getContent(cb)`, `getRequestContent(cb)`, `getHarEntry()`
- `devtools.network.onNavigated`
- `devtools.network.getHAR(cb)`, `getResponseBody(request, cb)`
- `devtools.panels.network.getHAR` (same underlying model)

This is what every GraphQL/REST/API inspector extension consumes. It is **the** reason
GraphQL Network Inspector and Altair exist as DevTools extensions.

## Current state here

`chrome-runtime.js` fabricates `RequestFinished` from `postMessage` events the frontend
broadcasts, and `getContent()` returns a **hardcoded base64 Rick & Morty payload** —
extensions only *appear* to work. `getHAR`/`getResponseBody`/`onNavigated` absent.

## RN mapping

Per [../OVERVIEW.md](../OVERVIEW.md#the-crux-what-inspected-window-and-network-mean-for-react-native):
the frontend already holds a real network model **if** the RN runtime reports CDP
`Network.*` events (opt-in; traffic can bypass the inspected runtime). Honest fidelity
ceiling: good for JS-thread `fetch`/`XHR` when network inspection is on; blind to native
side otherwise.

## Plan

1. **Rebuild on the frontend's own network model** — no separate capture. Ride the
   dispatch channel: frontend relays request-finished + `Network.getResponseBody` results
   to extension frames.
2. `Request` object with real `getContent/getRequestContent/getHarEntry`; `getHAR` built
   from the accumulated model.
3. `onNavigated`: map to target attach/reload or omit (document).
4. Degrade visibly when network inspection is unavailable (extensions should show "no
   network data" rather than silence).

## Definition of done

GraphQL Network Inspector shows real requests, headers, and JSON bodies from a running RN
app, end-to-end, no stubbed data.
