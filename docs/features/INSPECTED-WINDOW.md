# Inspected window (`chrome.devtools.inspectedWindow`)

| | |
| --- | --- |
| **Status** | 🟨 partial — `eval` and `reload` are real (CDP `Runtime.evaluate` / `Page.reload` over the shell's own bridge); `getResources` / `getSelectedNode` are inert |
| **Tier** | 1 |
| **Blocked by** | — (needs the CDP bridge, now in the shell: [src/main/cdp-bridge.js](../../src/main/cdp-bridge.js)) |

## Chrome surface

- `tabId` — id of the inspected tab
- `eval(expression, options?, cb)` — run JS in the inspected page; options:
  `useContentScriptContext`, `scriptExecutionContext`, `frameURL`; answers with the
  pair `[value, exceptionInfo]`
- `reload()`
- `getResources(cb)` (deprecated) / `getResourceContent(url, timeout, cb)`

## Current state here

`chrome.devtools.inspectedWindow.eval` evaluates in the running app. The chain:

```
panel/devtools frame  chrome.devtools.inspectedWindow.eval(expr, options?, cb)
        │  chrome-shim/devtools.js        (both overloads, promise + callback)
        ▼  DEVTOOLS_EVAL (async IPC)
main/ipc.js  ── frame-gated ──►  main/inspected-window.js
        ▼  sendCommand("Runtime.evaluate", {expression, returnByValue, awaitPromise})
main/cdp-bridge.js  ── host-range message ids ──►  Metro /inspector/debug  ──►  app
```

The bridge multiplexes by message id, so **host commands ride the frontend's own
debugger session** and the app never sees a second debugger (`>= HOST_ID_BASE` is
host territory; the frontend allocates 1,2,3,…). Replies with a host id are consumed
in main and never forwarded to the frontend.

Everything else is deliberately inert: `tabId` is a stable synthetic int per
extension; `getResources` answers `[]`; `getSelectedNode` answers `null`.

`reload()` is real: it maps onto CDP `Page.reload`, which RN's backend implements
(`HostAgent.cpp` -> `targetController_.getDelegate().onReload({ignoreCache,
scriptToEvaluateOnLoad})`), so it really reloads the JS bundle. Chrome's
`options.injectedScript` is the same idea as CDP's `scriptToEvaluateOnLoad` and is
mapped rather than dropped. Chrome's `reload()` has no callback and no promise, so
there is no API surface to report failure through: a rejected `Page.reload` (no
session, external-relay mode) is logged in the extension frame's console instead of
being swallowed.

## RN mapping and fidelity

| Sub-API | RN mapping | Fidelity |
| --- | --- | --- |
| `tabId` | synthetic constant | fine |
| `eval` | `Runtime.evaluate` (`returnByValue`, `awaitPromise`) | High for JSON-serializable values |
| `eval` + `frameURL` / `useContentScriptContext` / `scriptExecutionContext` | accepted, **ignored** | documented degradation: RN has no frames and no isolated content-script worlds — the app's global context is the only context, and RN aliases `global.window = global` (`Libraries/Core/setUpGlobals.js`), which is what state-debugger extensions need |
| `eval` timeout | **our own option** (Chrome has none) | bounds the wait; forwarded to `Runtime.evaluate` best-effort, reply deadline sits slack behind it |
| `reload` | `Page.reload` (`ignoreCache`, `injectedScript` → `scriptToEvaluateOnLoad`) | High for the JS bundle; RN reloads the bundle, not a DOM page. No callback in Chrome's API, so failures surface in the frame console |
| `getResources` / `getResourceContent` | `Debugger.getScriptParsed` + script source | not implemented (Tier 2) |

### Result mapping (implemented in `src/main/inspected-window.js`)

| CDP answer | Chrome pair |
| --- | --- |
| `result.value` present | `[value, null]` |
| `exceptionDetails` **with** `exception` | `[undefined, {isException: true, value: "Uncaught …", url, lineNumber, columnNumber, stackTrace}]` |
| `exceptionDetails` **without** `exception` | `[undefined, {isError: true, code, value, lineNumber}]` — Chrome keeps `isError` for tooling-side failures |
| `objectId` only (function, symbol, circular) or `unserializableValue` (NaN, BigInt, `-0`) | `[undefined, null]` — no JSON form exists; never guessed at or stringified into shape |
| no session attached / backend error reply / reply deadline exceeded | `[undefined, {isError: true, value: "<the host's actual reason>"}]` |

Nothing is fabricated: when the backend cannot answer, `eval` says so in
`exceptionInfo.value` (verified by `tests/inspected-window.test.js` and
`tests/devtools.test.js`).

## Plan

1. ~~Route `eval` through the host to the frontend's CDP connection~~ ✅ done — and
   the route turned out to be different: the frontend owns its socket directly
   (`?ws=` selects `WebSocketConnection`), so `sendMessageToBackend` was never
   reachable. The host owns the socket instead
   ([cdp-bridge.js](../../src/main/cdp-bridge.js)); see
   [DISPATCH-CHANNEL.md](DISPATCH-CHANNEL.md).
2. ~~Map exceptionInfo into Chrome's `{value, exceptionInfo}` callback shape~~ ✅.
3. ~~`tabId` constant~~ ✅. ~~`reload`~~ ✅ (`Page.reload`). Resources
   (`getResources` / `getResourceContent`) and `getSelectedNode`: still open (Tier 2).

## Definition of done

Redux-DevTools-pattern extension: `chrome.devtools.inspectedWindow.eval("window.__REDUX…")`
returns real app data from a running RN app.

**Status of the DoD:** the mechanism is implemented and unit-covered, and
`extensions/sample-extension/panel.html` asserts it live (three checks: real app
globals through `JSON.stringify({dev: globalThis.__DEV__, platform, window:
typeof globalThis.window})`, a page-side exception, an unserializable result). Those
checks need a device and a Metro server, which the CI here does not have — so the
status stays 🟨 until someone runs the panel against a real app and reports PASS.
Unrun = unverified: no live result is claimed in these docs.

## Open risk for the next layer (devtools.network)

`eval` needs one command and one reply, so it is indifferent to how the backend
shares the `Network` domain. The network work is not. From the sources:

- `jsinspector-modern/InspectorPackagerConnection.cpp:272` sets
  `capabilities/supportsMultipleDebuggers = true`, and Metro's proxy only disconnects
  a previous debugger when that capability is absent
  (`@react-native/dev-middleware/dist/inspector-proxy/Device.js:218`) — so a second
  *connection* would not evict the frontend. The bridge does not need it anyway: it
  multiplexes one session.
- `HostAgent.cpp:150` answers `Network.enable` with **an error when
  `getSystemState().registeredHostsCount > 1`** ("The Network domain is unavailable
  when multiple React Native hosts are registered"), and `emitSystemStateChanged`
  sends a `Network.disable` notification when the count changes. Note
  `registeredHostsCount` counts *registered host pages* in the app
  (`InspectorInterfaces.cpp:69-71`, incremented by `addPage`), **not** debugger
  connections — so opening a second debugger session is not what trips it.
- `NetworkHandler::enableAgent` (`network/NetworkHandler.cpp:40`) registers one agent
  per session and `sendToAllAgents` broadcasts, so two `Network.enable` callers on two
  sessions would each get their own agent id and both would receive events.
- **Unverified:** whether `registeredHostsCount > 1` occurs in the `app/` target (a
  multi-React-root or Fabric + bridge-mode app would do it), and whether
  `InspectorFlags::getNetworkInspectionEnabled()` is on by default for the app +
  Metro combination in use (`createDevMiddleware.js:83` reads
  `enableNetworkInspector ?? false`, and Metro's network-inspection experiment does
  not appear to reach the *frontend* URL the shell loads via Rozenite's
  `DEVTOOLS_FRONTEND_URL` override). Both need a device probe before the network
  layer is designed on top of them.
