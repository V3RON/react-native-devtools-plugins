# Host→frontend dispatch channel (`InspectorFrontendAPI` / `events` / CDP access)

| | |
| --- | --- |
| **Status** | 🟨 partial — channel live; **frontend→backend messaging is structurally unused** (the CDP bridge owns the socket instead) |
| **Tier** | 1 (infrastructure; unblocks most of Tier 1/2) |
| **Blocks** | panels events/theme, save flow, eye-dropper, device discovery |

## What Chrome does

`InspectorFrontendHost` is only the frontend→host direction. The host talks **back** by
dispatching events: the frontend exposes a global `InspectorFrontendAPI` whose methods
(`dispatchMessage`, `dispatchMessageChunk`, `showPanel`, `setInspectedTabId`,
`contextMenuItemSelected`, `savedURL`, `revealSourceLine`, `keyEventUnhandled`,
`colorThemeChanged`, `reloadInspectedPage`, device events, …) fire into
`InspectorFrontendHost.events` (upstream `EventDescriptors` defines the full table).
`InspectorFrontendHost.sendMessageToBackend(message)` is Chrome's frontend→backend CDP
escape hatch on the other side.

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

### `sendMessageToBackend` is dead code in this configuration — not a gap

This used to be listed as "the remaining blocker: the response contract is
fork-specific and must be verified against the real frontend". **That premise was
wrong**, and it pointed the wrong way.

In the frontend build we load
(`app/node_modules/@react-native/debugger-frontend/dist/third-party/front_end/core/sdk/sdk.js`),
the connection factory is:

```js
function Co(e) {
  if (getPathName().includes("rehydrated_devtools_app")) return new po(e);
  const t = queryParam("ws"), n = queryParam("wss");
  if (t || n) { …; return new WebSocketConnection(`${scheme}://${host}`, e); }
  return InspectorFrontendHostInstance.isHostedMode() ? new StubConnection : new MainConnection;
}
```

`sendMessageToBackend` is used by `MainConnection` **alone** (`sendRawMessage` →
`InspectorFrontendHostInstance.sendMessageToBackend(e)`; replies arrive as
`dispatchMessage`/`dispatchMessageChunk` events). Our frontend URL carries
`?ws=localhost:9223` (`src/main/config.js`), so the factory returns
`WebSocketConnection` and `MainConnection` is never constructed — the frontend dials
the socket itself. The host therefore cannot reach the backend *through* the
frontend, and `src/preload/frontend-host.js`'s no-op is correct, not missing work.

**Replaced by:** the shell owning the socket. `src/main/cdp-bridge.js` accepts the
frontend's connection, keeps the upstream session to Metro, and exposes
`sendCommand(method, params)` / `onEvent(method, handler)` to the host — multiplexed
onto the frontend's own session by message id, so no second debugger appears on the
app. First consumer: [inspected-window](INSPECTED-WINDOW.md).
Still missing:

- No producer yet for `showPanel`/`colorThemeChanged`/etc. — they only become
  meaningful as extension APIs grow.

## Plan

1. ~~Preload listens on IPC and calls `InspectorFrontendAPI.<event>(...)~~ ✅ done.
2. ~~Async-only IPC for new channels~~ ✅ done, and now unconditional: the last two
   `sendSync` channels (the injected-script store) are gone with the channel itself, so
   every IPC hop in the shell is `invoke`/`handle` (see `src/shared/ipc.js`).
3. ~~Wire `sendMessageToBackend` → the CDP socket the frontend owns~~ ✅ **resolved
   differently**: the escape hatch is structurally dead with `?ws=` in the URL, so the
   shell took over the socket instead (`src/main/cdp-bridge.js`). Do **not** wire
   `sendMessageToBackend` — it would only work by dropping `?ws=` and switching the
   frontend to `MainConnection`, trading a real socket for a chunked event protocol.
4. ~~Replace the `Events` postMessage bridge~~ ✅ done: the `Events` global is deleted
   (it had no producers left) and [devtools-network](DEVTOOLS-NETWORK.md) /
   [webRequest](WEBREQUEST.md) are consumers of the CDP bridge
   (`onEvent("Network.*")` in `src/main/network-model.js`), not a parallel transport.

## Definition of done

Frontend dispatches `showPanel` and `contextMenuItemSelected` round-trips through the
host; a real CDP command from an extension reaches the RN backend and its reply comes
back.

*Progress:* `contextMenuItemSelected` round-trip implemented (awaiting manual
verification against the running fork). The CDP-command round-trip is implemented
through the bridge instead of `sendMessageToBackend` — `chrome.devtools.inspectedWindow
.eval` is an extension-issued CDP command with a real reply, asserted live in
`extensions/sample-extension/panel.html` (needs a device: unrun = unverified).
`showPanel` still has no producer.
