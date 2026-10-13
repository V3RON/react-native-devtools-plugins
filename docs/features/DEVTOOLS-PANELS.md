# DevTools panels (`chrome.devtools.panels`)

| | |
| --- | --- |
| **Status** | 🟨 partial — `panels.create` and `themeName`/`themeChanged` are real and **shell-driven** (no fork knowledge); the rest is inert stubs |
| **Tier** | 1 (create/theme) / 2 (elements, sources, performance) |
| **Blocked by** | [DISPATCH-CHANNEL.md](DISPATCH-CHANNEL.md) (panel events, context menus) |

## Chrome surface

- `devtools.panels.create(title, iconPath, pagePath, cb) → Panel`
  - `Panel`: `onShown`, `onHidden`, `setWidth`
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

### Theme (`themeName` / `themeChanged`)

Chrome's values: `"default"` (light) and `"dark"`. The frontend is the authority, so the
bridge asks *it*, not the OS:

1. `panel-bridge.js` imports the frontend's own `ThemeSupport` (same module instance) and
   reads `themeName()`, which already resolves the `ui-theme` setting
   (`default` | `dark` | `systemPreferred`) against `prefers-color-scheme`. It reports on
   boot — before it creates any extension frame — and again on every `themechange` event
   (setting switched, or the system theme flipped while the setting is "System preference").
2. The report is one async IPC, `THEME_REPORT` (`window.__SHELL_HOST__.reportTheme`,
   exposed by the frontend preload). Main accepts it only from the frontend window's own
   main frame (`panelHost.isFrontendFrame`, by frame — never from an extension iframe),
   and `src/main/theme-host.js` refuses anything but the two names.
3. A real change is broadcast to **every** registered extension context (devtools pages,
   panel pages, background contexts) as a `RUNTIME_DELIVER` `{kind: "theme"}` push through
   the context registry; the shim updates `themeName` and fires `themeChanged(name)`.
   Repeated reports of the same theme fire nothing.
4. A frame that boots later learns the current theme from its `RUNTIME_REGISTER` reply.
   `themeName` is a live getter in the page world (`contextBridge` would otherwise freeze it
   at expose time).

Divergences, stated plainly: the reply is async, so a script that reads `themeName`
synchronously *before* registration lands sees `"default"` and then gets a `themeChanged`
if the real theme is `"dark"` (Chrome's value is available synchronously; in practice the
reply wins the race for deferred/module scripts — verified in
`docs/evidence/panels-theme/`). Background contexts get the API too because the shim
installs `chrome.devtools` everywhere; Chrome would not expose it there.

Note: the frontend's `View` ids reject anything outside `[A-Za-z0-9.-]` ("Invalid view
ID") — `panelIdFor` sanitizes path separators/underscores accordingly.

## Gaps

| Sub-API | Status | Notes |
| --- | --- | --- |
| `panels.create` | 🟨 | works; `width`/`icon` cosmetic bits unverified |
| `Panel.onShown/onHidden`, `setWidth` | ❌ | needs frontend events → dispatch channel |
| `themeName` / `themeChanged` | ✅ | the frontend's real theme (`"default"` light / `"dark"`), live; see [Theme](#theme-themename--themechanged) for the one remaining divergence |
| `elements.createSidebarPane` | ❌ | needs [inspected window](INSPECTED-WINDOW.md) (`Runtime.evaluate`) + RN element-tree selection; Redux-family devtools depend on it |
| `elements.onCreateContextMenu`, `inspectedObject`, `openResource` | ❌ | context-menu events ride the dispatch channel |
| `sources.openInFrontend` | ❌ | jump-to-source; RN DevTools has a Sources-like surface |
| `network.getHAR` | ❌ | see [DEVTOOLS-NETWORK.md](DEVTOOLS-NETWORK.md) |
| `performance.onRecording*` | ❌ | cheap if frontend exposes profiling state |

## Definition of done (Tier 1 slice)

`create` + `onShown/onHidden` + `themeName/themeChanged` (theme done) behave like Chrome for
UI-only extensions (Redux-style panels, Altair client tab).
