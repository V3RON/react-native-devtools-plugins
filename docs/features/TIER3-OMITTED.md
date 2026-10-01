# Tier 3 — omitted browser APIs (no-op shells only)

| | |
| --- | --- |
| **Status** | 🚫 deliberately out of scope |
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

- `devtools.recorder` — Chrome's Recorder panel has no RN analog.
- `devtools.inspectedWindow.reload`/`getResources` DOM semantics — degrade or omit
  ([features/INSPECTED-WINDOW.md](INSPECTED-WINDOW.md)).
- Chrome Sync backing for `storage.sync` — behaves as local
  ([features/STORAGE-AND-I18N.md](STORAGE-AND-I18N.md)).

## Acceptance test for this policy

An extension that *calls* any omitted API at startup must still load and render its panel
(degraded), never die on `TypeError: Cannot read properties of undefined`.
