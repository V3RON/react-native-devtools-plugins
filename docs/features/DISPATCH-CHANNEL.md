# Host→frontend dispatch channel (`InspectorFrontendAPI` / `events` / CDP access)

| | |
| --- | --- |
| **Status** | 🟨 partial — channel live; **frontend→backend messaging is structurally unused** (the host opens its own CDP session instead) |
| **Tier** | 1 (infrastructure; unblocks most of Tier 1/2) |
| **Blocks** | save flow, eye-dropper, device discovery |

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

**The channel is live** (`src/electron/shell/dispatch.js` → `HOST_EVENT` IPC → main-frame
preload → `window.InspectorFrontendAPI[name](...args)` in the frontend's main
world). Main process calls `dispatchToFrontend(eventName, args)`; the preload
warns-and-drops events raised before the frontend defined its API object
(same as Chrome, which only dispatches once the frontend is up).

First round-trip consumer: **context menus**. `showContextMenuAtPoint` builds a
native Electron `Menu` from the `ContextMenuDescriptor[]` (pure mapping in
`src/electron/shell/context-menu.js`, unit-tested) and pops it; the selection returns as
`contextMenuItemSelected(id)` and close as `contextMenuCleared`.

Second consumer, and the first one observed arriving end to end in a real run: the **file
save family** (`src/electron/shell/host-files.js`). `InspectorFrontendHost.save/append` answer with
`savedURL(url, fileSystemPath)`, `canceledSaveURL(url)` and `appendedToURL(url)`, which the
frontend's `FileManager` turns into the promise `save()` returns and the progress of a
streamed write (Console "Save as…", Network "Export HAR…";
[evidence](../evidence/electron-leftovers/README.md)). Note the hosted frontend draws its
own **soft** context menu, so the native-menu path above is not what the stock UI exercises.

**A bug this surfaced:** the preload's receiver called
`contextBridge.executeInMainWorld({func, arguments: [...]})`. Electron's option is `args`;
`arguments` is silently ignored, so the function ran with no arguments and every event was
dropped as `InspectorFrontendAPI.undefined not ready`. Fixed, with a source-level guard in
`tests/host-primitives.test.js`.

Also landed with it: async-only IPC for everything new (`invoke`/`handle` —
`src/electron/extensions/internal/broker/channels.js` house rule), and preferences/zoom/window ops now REAL.

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
`?ws=<Metro's inspector-proxy URL for the target>` (`src/electron/shell/frontend-target.js`
adds it from Metro's `/json/list`), so the factory returns
`WebSocketConnection` and `MainConnection` is never constructed — the frontend dials
the socket itself. The host therefore cannot reach the backend *through* the
frontend, and `src/electron/shell/frontend-host.js`'s no-op is correct, not missing work.

**Replaced by:** the host's own CDP session.
`src/electron/extensions/internal/cdp/cdp-session.js` opens a second, independent session to
the target in the frontend URL's `ws=`, next to the frontend's, and exposes
`sendCommand(method, params)` / `onEvent(method, handler)` / `onAttach` to the host. Nothing
sits between the frontend and the app. It needs the target to report
`supportsMultipleDebuggers` (checked on Metro's `/json/list` before every dial), because
otherwise a second debugger would evict the frontend. First consumer:
[inspected-window](INSPECTED-WINDOW.md).

Because the frontend's dial is made by the *frontend document itself*, the `Origin` it
presents on the upgrade is the origin of its own URL — `http://127.0.0.1:8081` on the default
frontend URL, and whatever `DEVTOOLS_FRONTEND_URL` says otherwise [inferred from the URL;
the header itself is Chrome's WebSocket behaviour, not measured against the fork here]. The
host's session sends that same origin explicitly (`Origin: <frontend URL origin>`), which is
what Metro's inspector proxy accepts. (The bridge on `:9223` that used to allowlist it,
issue #23, has been removed.)
Still missing:

- No producer yet for `colorThemeChanged`/etc.; they only become meaningful as
  extension APIs grow. (`showPanel` no longer travels this channel: the extension host selects its own tab
  through the panel bridge (`__SHELL_EXT_PANELS__.showPanel`, from `panelHost.showPanel(panelId)`
  in `src/electron/extensions/internal/frontend/panel-host.js`), so it has no dependency on the
  shell's InspectorFrontendAPI dispatch; see [DEVTOOLS-PANELS.md](DEVTOOLS-PANELS.md#showpanel-host---frontend).) (`chrome.devtools.panels.setThemeChangeHandler` does not need
  `colorThemeChanged`: it rides its own frontend-to-host report channel, see
  [DEVTOOLS-PANELS.md](DEVTOOLS-PANELS.md#theme-themename--setthemechangehandler).)

## Plan

1. ~~Preload listens on IPC and calls `InspectorFrontendAPI.<event>(...)~~ ✅ done.
2. ~~Async-only IPC for new channels~~ ✅ done, and now unconditional: the last two
   `sendSync` channels (the injected-script store) are gone with the channel itself, so
   every IPC hop in the shell is `invoke`/`handle` (see `src/electron/extensions/internal/broker/channels.js`).
3. ~~Wire `sendMessageToBackend` → the CDP socket the frontend owns~~ ✅ **resolved
   differently**: the escape hatch is structurally dead with `?ws=` in the URL, so the
   host opens its own session instead (`src/electron/extensions/internal/cdp/cdp-session.js`). Do **not** wire
   `sendMessageToBackend` — it would only work by dropping `?ws=` and switching the
   frontend to `MainConnection`, trading a real socket for a chunked event protocol.
4. ~~Replace the `Events` postMessage bridge~~ ✅ done: the `Events` global is deleted
   (it had no producers left) and [devtools-network](DEVTOOLS-NETWORK.md) /
   [webRequest](WEBREQUEST.md) are consumers of the host's CDP session
   (`onEvent("Network.*")` in `src/electron/extensions/internal/cdp/network-model.js`), not a parallel transport.

## Definition of done

Frontend dispatches `showPanel` and `contextMenuItemSelected` round-trips through the
host; a real CDP command from an extension reaches the RN backend and its reply comes
back.

*Progress:* `contextMenuItemSelected` round-trip implemented (awaiting manual
verification against the running fork). The CDP-command round-trip is implemented
over the host's own CDP session instead of `sendMessageToBackend` — `chrome.devtools.inspectedWindow
.eval` is an extension-issued CDP command with a real reply, asserted live in
`extensions/sample-extension/panel.html` (needs a device: unrun = unverified).
`showPanel` has a producer: `panelHost.showPanel(panelId)` selects a panel this host
registered (id checked against the live registry; host-internal, no extension API). Since the
host/shell split it asks the panel bridge (`InspectorView.showPanel`) rather than dispatching
`InspectorFrontendAPI.showPanel` over this channel; the evidence below predates that and shows
the same frontend call reached through the old route. And
`DEVTOOLS_SHOW_PANEL=<extensionId>[/<pagePath>]` is its first consumer. Verified live in
[../evidence/panel-events/](../evidence/panel-events/README.md): the shell opens on the
extension's tab with nothing clicked, and a `showPanel` dispatch from another tab switches
back and fires `Panel.onShown`. (A bug on `main` made every dispatched event run without its
arguments — `executeInMainWorld` takes `args`, not `arguments` — fixed in
`src/electron/shell/frontend-host.js`.)
