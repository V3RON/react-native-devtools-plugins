# DevTools panels (`chrome.devtools.panels`)

| | |
| --- | --- |
| **Status** | 🟨 partial — `panels.create`, `themeName`/`setThemeChangeHandler` and `Panel.onShown/onHidden` are real and **shell-driven** (no fork knowledge); the rest is inert stubs |
| **Tier** | 1 (create/theme) / 2 (elements, sources, performance) |
| **Blocked by** | [DISPATCH-CHANNEL.md](DISPATCH-CHANNEL.md) (context menus) |

## Chrome surface

- `devtools.panels.create(title, iconPath, pagePath, cb) → Panel`
  - `Panel`: `onShown(window)`, `onHidden` (and `onSearch`/`createStatusBarButton`, not
    implemented). `setWidth` is **not** part of Chrome's `ExtensionPanel`; it stays an inert
    shape in this shim for extensions that probe for it.
- `devtools.panels.themeName`, `setThemeChangeHandler(callback)` (Chrome 99+; there is no
  `themeChanged` event in any Chrome version — an earlier revision of this shim invented one)
- `devtools.panels.elements` (`ElementsPanel`): `createSidebarPane(title) →
  ExtensionSidebarPane` (`setObject`/`setExpression`/`setTitle`/`onContextMenu`),
  `openResource`, `inspectedObject`, `onCreateContextMenu`
- `devtools.panels.sources` (`SourcesPanel`): `openInFrontend`, `navigator`
- `devtools.panels.network`: `getHAR`
- `devtools.panels.performance`: `onRecordingStarted/Stopped`
- `devtools.panels.recorder`: omit ([TIER3-OMITTED.md](TIER3-OMITTED.md))
- `devtools.panels.openExtensionInDevtools(descriptor)` — relates to install flow

## How it works here today — shell-driven, no fork knowledge

1. **Scan**: `src/main/extensions.js` enumerates `extensions/` folders and parses each
   `manifest.json`; every folder with a `devtools_page` is "installed".
2. **Boot**: `src/main/panel-host.js` evaluates `src/frontend/panel-bridge.js` into the
   frontend's main world on every page load (waiting for `.main-tabbed-pane`, the same
   readiness signal Rozenite's `host.js` uses). The bridge dynamically imports the
   frontend's own `ui/legacy/legacy.js` — the very module instance the app already
   loaded — and spawns one hidden `rozenite://<id>/<devtools_page>` iframe per extension.
3. **Shim**: the extension-frame preload arms those frames with `chrome.*`, including
   `chrome.devtools.*` (`src/chrome-shim/devtools.js`) — installed for **every**
   extension frame, matching Chrome where devtools APIs reach panel pages too.
4. **Panels**: `chrome.devtools.panels.create` → `EXT_PANEL_CREATE` IPC (identity taken
   from the calling frame, never from payload) → the panel host asks the bridge to
   `InspectorView.addPanel(new SimpleView(title)).` The panel iframe is an ordinary
   extension frame. `panelId` derives from (extensionId, pagePath), so frontend reloads
   replay the registry and fresh `panels.create` calls dedupe against it.

All three bundled extensions (`sample-extension` "Osudio", GraphQL Network Inspector,
Altair GraphQL) register and render this way. The old `setInjectedScriptForOrigin`
channel (fork-provided devtools script) remains, unused by the stock frontend.

### Panel events (`Panel.onShown` / `onHidden`)

1. **Detect.** The bridge hooks `wasShown`/`willHide` on the panel's `SimpleView` (the
   widget lifecycle, so tab clicks, keyboard navigation, the overflow menu and `showPanel`
   all count) and reports through `window.__SHELL_HOST__.reportPanelVisible(panelId, shown)`
   (exposed by the frontend preload next to `reportTheme`) → `EXT_PANEL_VISIBILITY` IPC.
   The view is `setHideOnDetach()`, as the frontend's own `ExtensionView` does, so the panel
   page **stays alive** across hide/show like Chrome's (its document, scroll position and JS
   state survive; asserted by the Electron test).
2. **Route.** Main accepts that channel from the **frontend's main frame only**
   (`panelHost.isFrontendFrame`, the same check theme reports use), de-duplicates to real
   transitions, and pushes `EXT_PANEL_EVENT` to the **one devtools-page frame that created
   the panel** (recorded at `EXT_PANEL_CREATE` from the calling frame's registered identity).
   A reloaded devtools page re-creates its panels, dedupe keeps the tab, and the new frame
   takes the seat over — but **only a frame of the same extension may**, and the panel id is
   injective across extensions (`ext.<len>.<extensionId>.<path>`, `panelIdFor` in
   `src/shared/protocol.js`), so one extension can neither take over nor collide with
   another's panel. `panels.create` also refuses a `pagePath` that is not an existing file of
   the calling extension. A frontend reload clears the "shown" set; replayed panels start
   hidden.
3. **Deliver.** The shim fires the matching `Panel` events. `onShown`'s argument is the
   panel page's **real window**: the panel iframe is named after its panel id, and the devtools
   page's preload (main-world half; a `Window` cannot cross the `contextBridge`) resolves it
   with `window.open("", name)`, which returns an existing named frame without navigating it.
   Devtools page and panel page are both `rozenite://<id>`, so the window is fully scriptable
   (the sample extension writes into the panel's DOM through it). `window.parent.frames`
   cannot be used: the panel frame sits in a shadow tree. The frontend window denies **every**
   `window.open` (`src/main/window-open-policy.js`; nothing here needs one — `openInNewTab`
   goes through the host), so a name that matches no frame — or another extension's panel,
   which is cross-origin — gives `null`/an opaque proxy instead of spawning a window.
   - The **first** show is reported once the panel iframe has **loaded** (or after a 1.5 s
     grace period), because the window only exists usefully after that; `onShown` may thus lag
     the click by the page's load time, bounded (grace 1.5 s plus up to ~3 s waiting for the
     window to become readable, worst case). Later shows report immediately. A show -> hide
     before the first load emits nothing. Listeners of one panel are serialized, so `onHidden`
     can never overtake an `onShown` still waiting for the window.
   - `onHidden` carries no arguments, as in Chrome. If no window can be found, `onShown`
     receives `null` (Chrome always has one).

### `showPanel` (host -> frontend)

`panelHost.showPanel(panelId)` (`src/main/panel-host.js`) selects a hosted panel's tab over the
dispatch channel: `dispatchToFrontend("showPanel", [panelId])` → `InspectorFrontendAPI.showPanel`
→ the frontend's own `InspectorView` listener → `ViewManager.showView`. The id is checked
against the live registry (the frontend is only asked to show views this shell created),
the call waits for the bridge to have added the tab, and it is **host-internal**: Chrome has no
extension API for revealing a panel and no extension frame can reach it. Selecting the tab
fires the normal `wasShown` report, so `Panel.onShown` follows by the usual path. Consumer:
`DEVTOOLS_SHOW_PANEL=<extensionId>[/<pagePath>]` opens the shell on that extension's panel the
first time it registers (once).

### Theme (`themeName` / `setThemeChangeHandler`)

Chrome's values: `"default"` (light) and `"dark"`. The frontend is the authority, so the
bridge asks *it*, not the OS:

1. `panel-bridge.js` imports the frontend's own `ThemeSupport` (same module instance) and
   reads `themeName()`, which already resolves the `ui-theme` setting
   (`default` | `dark` | `systemPreferred`) against `prefers-color-scheme`. It reports on
   boot — before it creates any extension frame — and again on every `themechange` event
   (setting switched, or the system theme flipped while the setting is "System preference").
   This is best effort and bounded (try/catch, 2 s cap): if the module moved or the IPC
   hangs, panels are still created and the theme stays `"default"`.
2. The report is one async IPC, `THEME_REPORT` (`window.__SHELL_HOST__.reportTheme`,
   exposed by the frontend preload). Main accepts it only from the frontend window's own
   main frame (`isFrontendFrame`, decided by frame — never from an extension iframe),
   checks the frame before it reads the payload, and `src/main/theme-host.js` refuses
   anything but the two names.
3. A real change is broadcast to **every** registered extension context (devtools pages,
   panel pages, background contexts) as a `RUNTIME_DELIVER` `{kind: "theme"}` push through
   the context registry; the shim updates `themeName` and calls the registered `setThemeChangeHandler` callback with the name (one handler; each call
   replaces it; a non-function clears it; it is never called at registration, only on a change —
   the semantics of the frontend's own `models/extensions` implementation).
   Repeated reports of the same theme fire nothing.
4. **Boot value.** The bridge also appends `?__rozenite_theme=<name>` to the URL of every
   frame it creates (devtools pages and panels). The extension-frame preload runs before
   page scripts, validates the hint against the two names, sets `themeName` from it
   synchronously and removes it from the address with `history.replaceState` — the
   extension's own query string (encoding, order, repeats) and hash are kept byte for byte
   (`src/shared/theme.js`). Frames without a hint (background contexts, options pages) and
   all frames, as a fallback, take the theme from their `RUNTIME_REGISTER` reply, which wins
   over the hint if they disagree. The bridge omits the hint when it could not read the theme
   (a guessed "default" would boot a dark frontend's frames wrong).
5. `themeName` is a live getter in the page world (`contextBridge` would otherwise freeze
   it at expose time).

Divergences, stated plainly:
- For frames the bridge creates, `themeName` is correct from the first script, with no
  IPC timing involved. For other frames (background workers/pages) it starts at `"default"`
  until the register reply lands, then the handler is called if the theme is `"dark"`.
  Chrome exposes `chrome.devtools` only in DevTools frames, so that second case has no Chrome
  counterpart; the shim installs the API everywhere.
- The hint is in the frame's URL only until the preload strips it, before any extension
  script runs. Main normalises it away too (`stripThemeHintFromUrl`) before it records the
  frame's address for the message router, the frame observers and tab messages, so
  `MessageSender.url` is never hinted — asserted by the Electron test.
- `window.chromeElectron` (the shell's raw bridge handle, which carried an expose-time
  `themeName` snapshot and the internal helpers) is deleted from the page world once
  `chrome.*` is assembled; `chrome.devtools.panels.themeName` is the live getter.
- Test coverage: `tests/theme.test.js` (rules, frame check, hint parsing, byte-preserving
  strip) and `tests/theme-electron.test.js` (real broadcast, page-world surface, stripping,
  `sender.url`). The Electron run holds every register reply back (`--register-delay-ms`), so
  the hint is measured in isolation: with the host at "default" and a `dark` hint, the head
  script reads "dark" and the reply then overrides it with `setThemeChangeHandler("default")` (the
  host's state wins over the hint). Live evidence: `docs/evidence/panels-theme/`.

Note: the frontend's `View` ids reject anything outside `[A-Za-z0-9.-]` ("Invalid view
ID") — `panelIdFor` sanitizes path separators/underscores accordingly.

## Gaps

| Sub-API | Status | Notes |
| --- | --- | --- |
| `panels.create` | 🟨 | works; `width`/`icon` cosmetic bits unverified. **Divergence:** a `pagePath` that is not an existing file of the calling extension (including an empty one) is refused — no tab is created — where Chrome creates the tab and shows its 404 |
| `Panel.onShown/onHidden` | ✅ | real, incl. the panel `window` argument and panel pages that stay alive across hide/show; see [Panel events](#panel-events-panelonshown--onhidden). Verified live: [../evidence/panel-events/](../evidence/panel-events/README.md) |
| `Panel.setWidth` | n/a | not a Chrome API (`ExtensionPanel` has none); inert shape kept |
| `Panel.onSearch`, `createStatusBarButton` | ❌ | not implemented (deprecated / search UI) |
| host `showPanel` producer | ✅ | host-internal, id-validated; see [showPanel](#showpanel-host---frontend) |
| `themeName` / `setThemeChangeHandler` | ✅ | the frontend's real theme (`"default"` light / `"dark"`), live; see [Theme](#theme-themename--setthemechangehandler) for the one remaining divergence |
| `elements.createSidebarPane` | ❌ | needs [inspected window](INSPECTED-WINDOW.md) (`Runtime.evaluate`) + RN element-tree selection; Redux-family devtools depend on it |
| `elements.onCreateContextMenu`, `inspectedObject`, `openResource` | ❌ | context-menu events ride the dispatch channel |
| `sources.openInFrontend` | ❌ | jump-to-source; RN DevTools has a Sources-like surface |
| `network.getHAR` | ❌ | see [DEVTOOLS-NETWORK.md](DEVTOOLS-NETWORK.md) |
| `performance.onRecording*` | ❌ | cheap if frontend exposes profiling state |

## Definition of done (Tier 1 slice)

`create` + `onShown/onHidden` + `themeName/setThemeChangeHandler` (all done) behave like Chrome for
UI-only extensions (Redux-style panels, Altair client tab).
