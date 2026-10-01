# DevTools network (`chrome.devtools.network`)

| | |
| --- | --- |
| **Status** | 🟨 real CDP-backed model (`Network.*`), unverified on a device — `onNavigated` diverges, HAR gaps stay unknowns |
| **Tier** | 1 |
| **Blocked by** | RN network inspection (the CDP transport exists: [src/main/cdp-bridge.js](../../src/main/cdp-bridge.js)) |

## Chrome surface

- `devtools.network.onRequestFinished(listener)` — listener receives a `Request` object:
  `getContent(cb)`, `getRequestContent(cb)`, `getHarEntry()`
- `devtools.network.onNavigated`
- `devtools.network.getHAR(cb)`, `getResponseBody(request, cb)`
  (the latter is a shell addition here: it takes a `Request` *or* a requestId)
- `devtools.panels.network.getHAR` (same underlying model)

This is what every GraphQL/REST/API inspector extension consumes. It is **the** reason
GraphQL Network Inspector and Altair exist as DevTools extensions.

## Current state here

The model is real and the fake data is gone. One capture, in main, feeding both this API
and [WEBREQUEST.md](WEBREQUEST.md):

```
RN app ⇄ cdp-bridge ──onEvent("*")──► network-model.js ──► network-service.js ──IPC──► network-bridge.js
                    └──sendCommand("Network.enable" / "Network.getResponseBody")            ├─ chrome.devtools.network
                                                                                            └─ chrome.webRequest
```

- [src/main/network-model.js](../../src/main/network-model.js) accumulates one record per
  CDP `requestId` from `requestWillBeSent`, `requestWillBeSentExtraInfo`,
  `responseReceived`, `dataReceived`, `loadingFinished`, `loadingFailed` — plus the
  HAR 1.2 mapping (`buildHar`, `toHarEntry`) and the lazy `Network.getResponseBody`
  lookup that honours the backend's `base64Encoded` flag.
- [src/main/network-service.js](../../src/main/network-service.js) fans one message per
  lifecycle step out to the frames that asked for network data, and serves
  `getHar` / `getStatus` / `getBody` over async IPC
  (`NETWORK_SUBSCRIBE` / `NETWORK_GET_HAR` / `NETWORK_GET_STATUS` / `NETWORK_GET_BODY` /
  `NETWORK_DELIVER` in [src/shared/ipc.js](../../src/shared/ipc.js)).
- [src/chrome-shim/network-bridge.js](../../src/chrome-shim/network-bridge.js) builds the
  Chrome objects: `Request` with lazy `getContent`/`getRequestContent`, `getHAR` (promise
  **and** callback), real Event objects, and webRequest's filters. The shim decides which
  Chrome event each lifecycle step becomes; it never invents a value.
- The old fake is deleted: the hardcoded base64 body, `getContentBase64`, the `Events`
  postMessage global, and the synthetic `RequestStarted`/`RequestFinished` path. Grep for
  `Events` in `src/` and there is no producer or consumer left.

`getContent` answers `{content: null, encoding: null}` and logs the backend's own error
when there is no body; `getHAR` on an unavailable capture answers with an empty log. Both
are tested in [tests/network-end-to-end.test.js](../../tests/network-end-to-end.test.js).

### Reading the HAR object

`getHAR` returns a `harLog` that is usable both ways Chrome's consumers spell it:
`harLog.entries` (Chrome's docs) and `harLog.log.entries` (HAR 1.2 files) address the same
entry array, and each entry is a `Request` — so `entry.getContent()` works on the HAR
entries too.

### Lazy, bounded, and re-armed

- **Lazy**: nobody pays for `Network.enable` until a frame registers its first listener or
  calls `getHAR`; one command per frame-group, single-flight in the model.
- **Bounded**: a 500-record ring buffer. Eviction only ever drops the oldest *settled*
  record, so an in-flight request can never be lost mid-flight; an evicted record's body
  then honestly reports itself as unknown.
- **Re-armed**: a bundle reload (`Runtime.executionContextsCleared`) or a host-count
  change (`Network.disable`, `HostAgent.cpp:435`) means the old session's enable is gone,
  so the model re-enables. A refused enable backs off for 10s rather than hammering.

### Visible degradation

`Network.enable` can legitimately fail: multi-host app (`HostAgent.cpp:150`), or network
inspection compiled out (`InspectorFlags.cpp:44` → "Method not found."). In both cases:

- the frame gets a `status` push (and `getNetworkStatus()` reports it), including when a
  capture that was working **goes down mid-session** (`Network.disable` → refused re-enable),
- the panel's console gets one sentence: *"no network data from the inspected app:
  \<the backend's own reason\>"*,
- `getHAR()` stays empty and no listener fires — never a plausible-looking entry.

The push happens once per distinct availability state, and only for a verdict: an
in-flight `Network.enable` ("enabling") is not a verdict, so a panel is never told its
data is missing a moment before it arrives.

`getNetworkStatus()` is a **shell addition**, not Chrome's API; it exists so a panel can
print a reason instead of an unexplained empty list. Shape:
`{available, observing, enableState, reason, requests, finished}`.

## Fidelity ceiling and known unknowns

- HAR `timings.blocked/dns/connect/ssl` and both `headersSize` fields are `-1` — HAR's own
  "unknown". CDP gives one timestamp per lifecycle point, not Chrome's breakdown, and
  inventing a low number would be a lie that a waterfall chart would render as fact.
- `response.status` is `-1` for a request that never got a response (in flight or failed
  before one arrived), again HAR's own "no value", with `_failure` carrying the backend's
  `errorText`.
- `startedDateTime` comes from the notification's `wallTime`; `time`/`wait`/`receive` are
  differences of CDP's monotonic `timestamp`, so sub-millisecond float noise is real.
- **`onNavigated` diverges by design.** RN has no page navigations, so this fires on
  "the debugger is now looking at a different app session" (first attach, bundle reload)
  and carries the debugger target's title (`"devtools-poc (iPhone 17 Pro)"`) — or `""`
  when nothing is attached. That is the honest payload; a fabricated URL is not.
- `getResponseBody(requestOrId, cb)` is implemented as a shell-side convenience over the
  same lazy lookup (it mirrors what the vendored frontend's extension API exposes).
  `getHarEntry()` is **not** implemented as a method: a `Request` **is** the HAR entry
  (`request`, `response`, `timings`, `_resourceType`, `_transferSize`, `_requestId`), so
  Chrome's accessor would have nothing to compute.

## What has *not* been verified

The behaviour above is proven against a fake RN app that speaks CDP over a real WebSocket
([tests/network-end-to-end.test.js](../../tests/network-end-to-end.test.js)), and every
claim about the backend is read out of this repo's vendored RN
(`app/node_modules/react-native/ReactCommon/jsinspector-modern/`). It has **not** been run
against a device from this checkout, which is why the status is 🟨 and not ✅. Before
calling it real, on a device:

1. Tap REST/GraphQL in the sample app and confirm entries appear with real headers, bodies
   and status codes (the sample panel logs all of this).
2. Confirm Metro's `enableNetworkInspector` / the `DEVTOOLS_FRONTEND_URL` flag situation
   (see below) — if `Network.enable` comes back "Method not found.", the app's build has
   the domain compiled out and the extension will correctly report "no network data".
3. Confirm the multi-host refusal never triggers for a single-host app.

**Read before designing further on top of the bridge** (details in
[INSPECTED-WINDOW.md](INSPECTED-WINDOW.md#open-risk-for-the-next-layer-devtoolsnetwork)):

- `Network.enable` is refused with an **error** when the app has more than one registered
  RN host (`HostAgent.cpp:150`), and `emitSystemStateChanged` emits a `Network.disable`
  notification when that count changes. That count is about *hosts in the app*, not
  debugger sessions — so the bridge is not the trigger, but a multi-root app could be.
- `NetworkHandler` (`network/NetworkHandler.cpp:40`) supports several enabled agents and
  broadcasts to all of them, so a second `Network.enable` caller does not starve the
  frontend's own Network panel — it just doubles the event traffic on one socket. This is
  why `Network.enable` here is lazy: the frontend and Rozenite's middleware ask for it too.
- Network inspection is gated by `InspectorFlags::getNetworkInspectionEnabled()` =
  `enableBridgelessArchitecture() && fuseboxNetworkInspectionEnabled()`, and Metro's
  `enableNetworkInspector` experiment (which adds `unstable_enableNetworkPanel=true` to
  the frontend URL, `getDevToolsFrontendUrl.js:24`) defaults to `false`. With
  `DEVTOOLS_FRONTEND_URL` pointed at Rozenite's own `rn_fusebox.html`, whether that flag
  is on for our frontend is **unverified** — the whole feature can be off on both sides.
  The model's job in that case is to say so, which it does.

## RN mapping

Per [../OVERVIEW.md](../OVERVIEW.md#the-crux-what-inspected-window-and-network-mean-for-react-native):
the frontend already holds a real network model **if** the RN runtime reports CDP
`Network.*` events (opt-in; traffic can bypass the inspected runtime). Honest fidelity
ceiling: good for JS-thread `fetch`/`XHR` when network inspection is on; blind to native
side otherwise. Traffic that never goes through the inspected runtime's network stack is
invisible here, and no amount of shim work changes that.

## Follow-ups

- Replay accumulated history to frames that subscribe late (the model already holds it;
  the first `getHAR` sees it, `onRequestFinished` does not re-fire).
- Per-frame URL filtering in main, if the fan-out volume ever matters.

## Definition of done

GraphQL Network Inspector shows real requests, headers, and JSON bodies from a running RN
app, end-to-end, no stubbed data.

Code-side this is done and covered by tests: real events, real headers, real HAR, lazy
real `Network.getResponseBody` bodies, and an explicit "no network data" state. What is
left is the device run above — with network inspection compiled out of an app build, the
correct outcome is an empty panel *that says why*, and that path is already tested.
