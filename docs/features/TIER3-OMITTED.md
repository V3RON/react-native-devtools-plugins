# Tier 3 — omitted browser APIs (no-op shells only)

| | |
| --- | --- |
| **Status** | 🚫 deliberately out of scope + 🚷 no anchor in RN DevTools ([Anchors RN DevTools itself does not have](#anchors-rn-devtools-itself-does-not-have-)) |
| **Tier** | 3 |

Everything below presupposes **a web browser the extension controls**, which does not
exist here. Policy (from [../OVERVIEW.md](../OVERVIEW.md)): keep the *shape* alive where
crash risk is real (inert `addListener`, methods resolving empty results, events that
never fire); otherwise leave `undefined`. Document every divergence.

## Page / DOM access

- `chrome.scripting` (`executeScript`/`insertCSS`), `chrome.dom`, `userScripts`,
  `declarativeContent`, `pageCapture`, `tabCapture`.
  (Injecting via `Runtime.evaluate` is *eval*, not DOM injection — don't fake a DOM.)
- DOM-manipulating `content_scripts`: out of scope here; bridge-style ones are in scope →
  [features/CONTENT-SCRIPTS.md](CONTENT-SCRIPTS.md).

## Anchors RN DevTools itself does not have 🚷

These are not choices and not work-in-progress: the Chrome surface they extend is absent from
React Native DevTools, so no amount of shim work makes them real. Listed once in
[../OVERVIEW.md](../OVERVIEW.md#what-rn-devtools-actually-offers-the-anchor-list); marked 🚷
wherever they appear so the open-items lists stay clean.

| Omitted | The anchor that does not exist |
| --- | --- |
| `devtools.panels.elements.*` (`createSidebarPane`, `inspectedObject`, `openResource`, `onCreateContextMenu`) | no **Elements panel** |
| `devtools.inspectedWindow.getSelectedNode` | no selected **DOM node** (no `DOM` domain in jsinspector-modern) |
| DOM `content_scripts`, `chrome.scripting`, `insertCSS` | no **document** to inject into |
| `action` popups, a real `contextMenus`, `sidePanel` drawer, `omnibox`, shortcut routing to an extension | no **browser chrome UI** (the shells stay, the events have no producer). One exception: `commands.onCommand` **is** producible here via the Electron app menu, so it remains an open item |
| `devtools.recorder` | no **Recorder panel** |
| `chrome.webRequest` **blocking**, `declarativeNetRequest` | no CDP **`Fetch` domain** in the RN backend (see [features/WEBREQUEST.md](features/WEBREQUEST.md)) |
| `devtools.inspectedWindow.reload`/`getResources` **DOM semantics** | no page navigations; `reload` maps to a bundle reload instead |

The React **Components** panel is not a substitute for the Elements panel in any of the above:
it renders React's own tree inside an integrated React DevTools, exposes no selection to
extensions, and wiring sidebars to it would be a new product feature rather than Chrome API
fidelity.

## Browser chrome UI

What is omitted here is the **surface**, not the namespace: `action` popup semantics,
`omnibox`, a real browser right-click menu, a real side-panel drawer, keyboard-shortcut
routing to an extension. `action`, `contextMenus`, `sidePanel` and `commands` are still
injected as accept-and-grant shells so a worker that names them loads — see
[features/SMALL-SHIMS.md](SMALL-SHIMS.md) for what each one can honestly do and which of
its events therefore has no producer.

## Browser data & state

`bookmarks`, `history`, `cookies`, `sessions`, `topSites`, `readingList`, `search`,
`browsingData`, `webNavigation`, downloads DB, `proxy`, `privacy`, `contentSettings`,
`fontSettings`, `accessibilityFeatures`.

## Browser network control

`declarativeNetRequest`, **blocking** `webRequest` (needs CDP `Fetch` — unsupported by RN
backends today, see [features/WEBREQUEST.md](WEBREQUEST.md)), `dns`,
`certificateProvider`, `platformKeys`, `webAuthenticationProxy`, `vpnProvider`.

## Chrome identity / infra

`identity` (OAuth; could be a generic loopback helper someday, nothing RN needs today),
`gcm`, `instanceID`, `power`, `idle`, `system.*`, `loginState`, all `enterprise.*`, all
ChromeOS-only APIs (`input.ime`, `wallpaper`, `printing*`, `fileSystemProvider`,
`fileBrowserHandler`, `documentScan`, `audio`, `tts*`, `systemLog`), `printerProvider`,
`mimeHandler`, `desktopCapture`, `management`, `offscreen` (its purpose — a hidden DOM
document — doesn't exist), `runtime.requestUpdate`, `runtime.connect`/`sendMessageExternal`
(native/external messaging).

## DevTools-specific exclusions

- `devtools.recorder` — 🚷 Chrome's Recorder panel has no RN analog.
- `devtools.inspectedWindow` **DOM semantics** — `getSelectedNode` 🚷 (no Elements panel);
  the `getResources` *list* is still implementable over `Debugger.getScriptParsed`, it just
  reports scripts, not DOM resources ([features/INSPECTED-WINDOW.md](INSPECTED-WINDOW.md)).
- Chrome Sync backing for `storage.sync` — behaves as local
  ([features/STORAGE-AND-I18N.md](STORAGE-AND-I18N.md)).

## Acceptance test for this policy

An extension that *calls* any omitted API at startup must still load and render its panel
(degraded), never die on `TypeError: Cannot read properties of undefined`.
