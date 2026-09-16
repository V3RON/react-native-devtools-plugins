# `chrome.webRequest`

| | |
| --- | --- |
| **Status** | 🟡 stub — observe-only, 2 of 9 events, fake data |
| **Tier** | 2 |
| **Blocked by** | [DISPATCH-CHANNEL.md](DISPATCH-CHANNEL.md), [DEVTOOLS-NETWORK.md](DEVTOOLS-NETWORK.md) (same source model) |

## Chrome surface

- Nine events: `onBeforeRequest`, `onBeforeSendHeaders`, `onSendHeaders`,
  `onHeadersReceived`, `onResponseStarted`, `onAuthRequired`, `onBeforeRedirect`,
  `onCompleted`, `onErrorOccurred`
- URL filters (`matches`, `types`, `tabId`), `ResourceType` enum
- **Blocking** listeners (`webRequestBlocking`) that can cancel/redirect/modify
- MV3 note: blocking is already gone from Chrome itself (→ `declarativeNetRequest`);
  observation requires `webRequest` permission

## Current state here

`src/chrome-shim` emits `onBeforeRequest` + `onBeforeSendHeaders` from synthetic
frontend postMessages; the other listeners are empty `addListener`s. Nothing blocking,
no filters honored, bodies fake.

## RN mapping

- Observability: re-emit from the same CDP `Network.*` model as
  [DEVTOOLS-NETWORK.md](DEVTOOLS-NETWORK.md) (one capture, two APIs).
- **Blocking: not feasible.** CDP `Fetch` domain is unsupported by RN/JSI backends today;
  `declarativeNetRequest` is 🚫 out of scope anyway. Non-blocking promise semantics only.
- URL filters: mostly honored trivially (match against request URL); `tabId` = synthetic.

## Plan

1. After the dispatch channel: emit real `onBeforeRequest`/`onSendHeaders`/
   `onResponseStarted`/`onCompleted`/`onErrorOccurred` with correct `ResourceType`.
2. Implement `webRequest` filter matching.
3. Return inert listeners for the rest; document non-blocking divergence.

Note: few *DevTools* extensions actually use `webRequest` (it's mostly a
background-worker API); this stays Tier 2 behind everything else.
