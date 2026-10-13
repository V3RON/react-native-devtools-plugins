# DevTools panels (`chrome.devtools.panels`)

| | |
| --- | --- |
| **Status** | 🟨 partial — `panels.create` and `Panel.onShown/onHidden` are real and **shell-driven** (no fork knowledge); the rest is inert stubs |
| **Tier** | 1 (create/theme) / 2 (elements, sources, performance) |
| **Blocked by** | [DISPATCH-CHANNEL.md](DISPATCH-CHANNEL.md) (context menus) |

## Chrome surface

- `devtools.panels.create(title, iconPath, pagePath, cb) → Panel`
  - `Panel`: `onShown(window)`, `onHidden` (and `onSearch`/`createStatusBarButton`, not
    implemented). `setWidth` is **not** part of Chrome's `ExtensionPanel`; it stays an inert
    shape in this shim for extensions that probe for it.
- `devtools.panels.themeName`, `themeChanged`
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

5. **Panel events** (`Panel.onShown` / `onHidden`): the bridge hooks `wasShown`/`willHide` on
   the panel's `SimpleView` (the widget lifecycle, so tab clicks, keyboard navigation and
   the overflow menu all count) and reports through the shell-only
   `InspectorFrontendHost.setExtensionPanelVisible(panelId, shown)` →
   `EXT_PANEL_VISIBILITY` IPC. Main accepts that channel from the **frontend's main frame
   only** (`panelHost.isFrontendFrame`), de-duplicates to real transitions, and pushes
   `EXT_PANEL_EVENT` to the **one devtools-page frame that created the panel** (recorded at
   `EXT_PANEL_CREATE` from the calling frame's identity; a reloaded devtools page re-creates
   its panels, dedupe keeps the tab, and the new frame takes over the seat, so a stale frame
   never hears events). Chrome gives the `Panel` object to that page and no other, and so
   does this. A frontend reload clears the "shown" set; the replayed panels start hidden.
   - **`onShown`'s window argument is real.** The panel iframe is named after its panel id;
     the devtools page's preload (main-world half) resolves it with `window.open("", name)`,
     which returns an existing named frame without navigating it. Devtools page and panel
     page are both `rozenite://<id>`, so the returned window is fully scriptable (the sample
     extension writes into the panel's DOM through it). `window.parent.frames` cannot be
     used: the panel frame sits in a shadow tree. A lookup that found no frame would open a
     popup, which is detected (top-level `about:blank`) and closed.
   - "Shown" is reported once the panel iframe has **loaded** (or after a 1.5 s grace
     period), because the devtools page can only obtain the window once its browsing context
     is registered; `onShown` therefore fires slightly after the click, like Chrome's
     (which also hands over a ready window). Listeners of one panel are serialized, so
     `onHidden` can never overtake an `onShown` still waiting for the window.

Note: the frontend's `View` ids reject anything outside `[A-Za-z0-9.-]` ("Invalid view
ID") — `panelIdFor` sanitizes path separators/underscores accordingly.

## Gaps

| Sub-API | Status | Notes |
| --- | --- | --- |
| `panels.create` | 🟨 | works; `width`/`icon` cosmetic bits unverified |
| `Panel.onShown/onHidden` | ✅ | real, incl. the panel `window` argument; see "Panel events" above. Verified live: [../evidence/panel-events/](../evidence/panel-events/README.md) |
| `Panel.setWidth` | n/a | not a Chrome API (`ExtensionPanel` has none); inert shape kept |
| panel page lifetime | 🟨 divergence | DevTools detaches a hidden tab's content, so the **panel page reloads on every show** (pre-existing, visible now because `onShown` hands over each fresh window). Chrome keeps panel pages alive; state must live in the devtools page (as the sample extension does) or storage. `onHidden` carries no window, as in Chrome. |
| `Panel.onSearch`, `createStatusBarButton` | ❌ | not implemented (deprecated / search UI) |
| `themeName` / `themeChanged` | ❌ | frontend theme is known; cheap, high polish |
| `elements.createSidebarPane` | ❌ | needs [inspected window](INSPECTED-WINDOW.md) (`Runtime.evaluate`) + RN element-tree selection; Redux-family devtools depend on it |
| `elements.onCreateContextMenu`, `inspectedObject`, `openResource` | ❌ | context-menu events ride the dispatch channel |
| `sources.openInFrontend` | ❌ | jump-to-source; RN DevTools has a Sources-like surface |
| `network.getHAR` | ❌ | see [DEVTOOLS-NETWORK.md](DEVTOOLS-NETWORK.md) |
| `performance.onRecording*` | ❌ | cheap if frontend exposes profiling state |

## Definition of done (Tier 1 slice)

`create` + `onShown/onHidden` (done) + `themeName/themeChanged` behave like Chrome for
UI-only extensions (Redux-style panels, Altair client tab).
