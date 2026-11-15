# Debugger (`chrome.debugger`)

| | |
| --- | --- |
| **Status** | 🟨 real: `attach`, `detach`, `sendCommand`, `getTargets`, `onEvent`, `onDetach`, over a debugger session of the extension's own to the inspected app. What a command does is up to the app |
| **Tier** | 2 |
| **Blocked by** | — at build time. At run time, a target that reports `supportsMultipleDebuggers` ([LIMITATIONS.md](../LIMITATIONS.md)) |

## Chrome surface

- `attach(target, requiredVersion, callback?)`, `detach(target, callback?)`
- `sendCommand(target, method, commandParams?, callback?)` → the command's result
- `getTargets(callback?)` → `TargetInfo[]`
- `onEvent(source, method, params)`, `onDetach(source, reason)`
- A target is a `Debuggee`: `tabId`, `extensionId` or `targetId`, plus an optional `sessionId`
  for a child session (Chrome 125+). Needs the `debugger` permission.

## Current state here

Every extension that calls `attach` gets a CDP session **of its own** to the inspected app.
It dials the same `ws=` as the host's session, with the same Origin and after the same
`supportsMultipleDebuggers` check (`cdp-session.js`). React Native's backend keeps sessions
apart: a domain enabled on one session reports to that session only. So what an extension
enables, the events it hears, and what it turns off never reach the DevTools frontend or the
host's own session.

```
panel / devtools page / background   chrome.debugger.*        (shim/debugger.js)
        │  DEBUGGER_ATTACH / _DETACH / _SEND / _GET_TARGETS   (async IPC, `debugger` grant)
        ▼
broker/ipc.js ──► cdp/debugger-service.js     one attachment per extension
        │            └─ cdp-session.js        reconnect: false, no command timeout, no prime
        ▼
Metro /inspector/debug ──► app       ◄── the frontend's session, and the host's
        │
        └─ events and onDetach ──► RUNTIME_DELIVER {kind: "debugger"} ──► every context of the extension
```

**Commands are forwarded, not checked.** `sendCommand` sends the method and params as
given, and returns the app's answer as it came back. There is no list of supported domains to
fall out of step with React Native. An unsupported method reaches the app, and the app
answers `-32601 Unsupported method`. Chrome's domain restriction isn't copied either: it
keeps extensions away from browser internals this host doesn't have. A refused command
fails with the backend's error object serialized as JSON, which is the text Chrome puts in
`runtime.lastError` (`{"code":-32601,"message":"Unsupported method 'DOM.getDocument'"}`).

What the host does own is the API's contract:

- **Who.** The attachment belongs to the calling frame's extension, read from the frame's URL
  in main. Every context of that extension shares it, and every context with an `onEvent`
  listener hears its events. Another extension can't send on it, detach it, or hear it.
- **Which app.** A debuggee is the inspected app: by tab id (the extension's own
  `chrome.devtools.inspectedWindow.tabId`, the same id `chrome.tabs` uses), or by the target
  id `getTargets` reports (the app's `/json/list` id). `extensionId` debuggees are refused:
  there are no extension pages to debug here.
- **One at a time.** A second `attach` from the same extension is refused with Chrome's
  `Another debugger is already attached to the tab with id: N.`. Different extensions each
  get their own session.
- **Lifetime.** An attachment ends with its socket. When the app or the proxy closes it,
  `onDetach(source, "target_closed")` fires and the host doesn't dial again: the domains
  the extension had enabled died with that session, and Chrome doesn't revive a detached
  debuggee either. The extension may `attach` again. Closing the DevTools window ends every
  attachment the same way. The extension's own `detach` closes it quietly, as in Chrome.
- **No timeout.** Chrome puts none on `sendCommand`, and a heap snapshot or a profile can take
  longer than any budget. A command fails only when the app answers with an error, or when
  the attachment ends (`Detached while handling command.`).
- **`getTargets`** answers the one app while the host's session is attached (an empty list
  otherwise), with `attached: true`: the DevTools frontend is always attached to it.

## What React Native answers (0.88, measured)

Probed on a session of its own against Expo SDK 58 / React Native 0.88.1 on the iOS simulator.

| Domain | Answers | Refuses (`-32601`) |
| --- | --- | --- |
| Runtime | `enable`, `evaluate`, `callFunctionOn`, `getProperties`, `releaseObjectGroup`, `addBinding`/`removeBinding`, `getHeapUsage` | `getIsolateId`, `runIfWaitingForDebugger` |
| Network | `enable`, `getResponseBody` | `setCacheDisabled`, `setExtraHTTPHeaders`, `emulateNetworkConditions` (Metro answers `loadNetworkResource` with its own error) |
| Debugger | `enable`, `disable`, `setBreakpointsActive`, `setPauseOnExceptions` (the ones probed) | — |
| Log, Tracing | `enable`/`disable`; `start`/`end` | `Tracing.getCategories` |
| Profiler, HeapProfiler | `Profiler.start`/`stop`, `HeapProfiler.collectGarbage` | `enable`/`disable` on both |
| ReactNativeApplication | `enable`, `disable` | — |
| Page, DOM, CSS, Console, Fetch, Emulation, Input, Inspector, Performance, Storage, Target, … | — | everything |

Things an extension written for Chrome should expect:

- **No WebSocket events by default.** React Native reports `Network.webSocket*` only when
  the native feature flag `fuseboxWebSocketEventsEnabled` is on, and it is off by default (a
  socket opened, echoed and closed in the app produced none). Expo Go can't change native
  flags. GraphQL Network Inspector 2.26 tracks WebSockets this way: its panel loads and
  attaches, and its WebSocket view stays empty unless the app turns the flag on.
- **`Runtime.evaluate` ignores `awaitPromise`** on Hermes: a promise comes back as the
  promise object.
- **No `Target` domain**, so no child sessions: a `sessionId` is forwarded as given, and
  the app has none to match it.

## Not done

- Chrome's "is debugging this browser" infobar: nothing in this shell says an extension is
  attached, beyond the host's log line.
- Commands that act on the whole app reach it from any attached extension:
  `Debugger.pause` stops the app under the frontend too, and Hermes has one sampling profiler,
  so an extension's `Profiler.stop` can end a profile the Performance panel was recording
  ([LIMITATIONS.md](../LIMITATIONS.md)). `chrome.devtools.inspectedWindow.eval("debugger")`
  could already pause the app without any permission.

## Tests

- `tests/debugger-service.test.js` — main's half against a fake inspector proxy with one
  session per connection: attach and its refusals, forwarding, errors, per-session events,
  `target_closed`, detach, no timeout.
- `tests/debugger-shim.test.js` — the frame's half: both calling conventions, lastError,
  the permission gate, deliveries.
- `tests/cdp-session.test.js` — `reconnect: false`, `onDetach`, `requestTimeoutMs: 0`, the
  backend's error object, `sessionId`.
- `tests/debugger-electron.test.js` — a real `rozenite://` panel in Electron attaches to a
  fake app, sends, hears `Network.*`, gets the app's error, detaches. A panel without the
  permission is refused.
