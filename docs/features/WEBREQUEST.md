# `chrome.webRequest`

| | |
| --- | --- |
| **Status** | 🟨 observe-only, 7 of 9 events from the real CDP model — filters and `ResourceType` real, blocking impossible by construction |
| **Tier** | 2 |
| **Blocked by** | [DEVTOOLS-NETWORK.md](DEVTOOLS-NETWORK.md) (same source model, shared with it) |

## Chrome surface

- Nine events: `onBeforeRequest`, `onBeforeSendHeaders`, `onSendHeaders`,
  `onHeadersReceived`, `onResponseStarted`, `onAuthRequired`, `onBeforeRedirect`,
  `onCompleted`, `onErrorOccurred`
- URL filters (`matches`, `types`, `tabId`), `ResourceType` enum
- **Blocking** listeners (`webRequestBlocking`) that can cancel/redirect/modify
- MV3 note: blocking is already gone from Chrome itself (→ `declarativeNetRequest`);
  observation requires `webRequest` permission

## Current state here

One capture, two APIs: this namespace and [DEVTOOLS-NETWORK.md](DEVTOOLS-NETWORK.md)
consume the *same* main-process model
([src/main/network-model.js](../../src/main/network-model.js) →
[network-service.js](../../src/main/network-service.js)), and
[src/chrome-shim/network-bridge.js](../../src/chrome-shim/network-bridge.js) decides which
Chrome event each lifecycle step becomes. The synthetic frontend postMessages and the fake
bodies are gone.

### Which of the nine events actually fire

| Event | Emitted? | From |
| --- | --- | --- |
| `onBeforeRequest` | yes | `Network.requestWillBeSent` |
| `onBeforeSendHeaders` | yes | `Network.requestWillBeSent` |
| `onSendHeaders` | yes | `Network.requestWillBeSentExtraInfo` |
| `onBeforeRedirect` | yes | the redirect re-announcement (`Network.redirectResponse`) |
| `onResponseStarted` | yes | `Network.responseReceived` (non-3xx) |
| `onCompleted` | yes | `Network.loadingFinished` |
| `onErrorOccurred` | yes | `Network.loadingFailed` |
| `onHeadersReceived` | **no** | no CDP counterpart on this backend |
| `onAuthRequired` | **no** | no CDP counterpart on this backend |

The two silent ones are still registrable — Chrome's shape, `hasListener`/`removeListener`
included — so feature detection and cleanup code keeps working; they simply never fire
because RN's `NetworkHandler` has no notification that could feed them.

`onBeforeRequest` and `onBeforeSendHeaders` come from **one** CDP notification: RN reports
a request together with its headers (`react/networking/NetworkReporter.cpp:57`), so there
is no earlier "headers not attached yet" moment to separate them into. Both carry the real
headers the backend reported. When the extra-info notification does arrive, `onSendHeaders`
carries the wire headers.

`net::ERR_ABORTED` is reported as `details.canceled = true` with no `error`, which is
Chrome's own convention rather than this shell's invention.

### Filters

Matched locally in [src/chrome-shim/web-request.js](../../src/chrome-shim/web-request.js),
on both syntaxes Chrome documents:

- **match patterns** (`https://*.example.com/*`, `<all_urls>`) split into
  scheme/host/path with Chrome's rules — case-insensitive host, `*.` matching any
  subdomain *or* none, `_` matching inside one label, path matched against path+query;
- **glob patterns** (`*example.com*`), WebRequest's historical syntax, for anything that is
  not a valid match pattern.

`types` (a `ResourceType` list) applies as well, and an unusable pattern matches nothing
instead of throwing at registration time. `tabId` is Chrome's own constant `-1`: there is
no tab model here, so a filter on it can only ever match `-1`.

### `ResourceType`

Mapped in main (`serializeRecord`), so every frame agrees: CDP `XHR`/`Fetch`/`Preflight`
→ `xmlhttprequest`, `Document` → `main_frame`, `Script` → `script`, and so on across the
whole CDP enum. RN's own mapping is MIME-derived and only ever yields Document /
Stylesheet / Image / Media / Script / XHR / Other (`network/CdpNetwork.cpp:144`), so that
is what shows up in practice; the full table exists so a richer backend still lands on a
real Chrome value instead of an invented one.

### Blocking: not feasible, and it says so

RN implements no CDP `Fetch` domain, so nothing here can cancel, redirect, or rewrite a
request. `addListener(cb, filters, ["blocking"])` registers normally — extensions do not
crash — and the frame logs one sentence, once: *"this host is observe-only … a listener can
never block, cancel or rewrite a request"*. Listeners must not expect a blocking return
value. The read-only hints Chrome documents (`requestBody`, `responseHeaders`) are answered
and produce no warning. MV3 dropped blocking in Chrome anyway, so this divergence shrinks
over time.

`requestBody` arrives as Chrome's `raw: [{bytes: Uint8Array}]`, decoded from the real
`postData` the backend reported.

## RN mapping

- Observability: re-emit from the same CDP `Network.*` model as
  [DEVTOOLS-NETWORK.md](DEVTOOLS-NETWORK.md) (one capture, two APIs).
- Blocking: see above — structurally unavailable, reported rather than pretended away.
- Traffic that bypasses the inspected runtime's network stack is invisible here, exactly as
  in DEVTOOLS-NETWORK.md.

## What has *not* been verified

Covered by [tests/web-request.test.js](../../tests/web-request.test.js),
[network-bridge.test.js](../../tests/network-bridge.test.js), and the real-socket
[end-to-end test](../../tests/network-end-to-end.test.js); the claims about the backend are
read out of this repo's vendored RN. Not run against a device from this checkout — hence 🟨,
not ✅. The device run listed in DEVTOOLS-NETWORK.md covers this namespace too: the sample
panel logs every `onBeforeRequest` it sees with URL, method and type.

## Definition of done

Observe-only parity for the seven events this backend can honestly produce, with real
`ResourceType`, real filters, and real bodies — done and tested. Blocking stays out of
reach as long as RN has no CDP `Fetch` domain; that divergence is documented rather than
fixed.
