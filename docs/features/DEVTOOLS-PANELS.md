# DevTools panels (`chrome.devtools.panels`)

| | |
| --- | --- |
| **Status** | 🟨 partial — `panels.create` works end-to-end; the rest is missing |
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

## How it works here today

The frontend fork injects its `chrome.devtools.*` implementation into `rozenite:` iframes
via the `setInjectedScriptForOrigin` channel (see
[../ARCHITECTURE.md](../ARCHITECTURE.md)). `sample-extension/devtools.js`'s
`chrome.devtools.panels.create("Osudio", null, "/panel.html")` registers a tab; the panel
HTML loads in an iframe. GraphQL Network Inspector and Altair both create their tabs this
way.

## Gaps

| Sub-API | Status | Notes |
| --- | --- | --- |
| `panels.create` | 🟨 | works; `width`/`icon` cosmetic bits unverified |
| `Panel.onShown/onHidden`, `setWidth` | ❌ | needs frontend events → dispatch channel |
| `themeName` / `themeChanged` | ❌ | frontend theme is known; cheap, high polish |
| `elements.createSidebarPane` | ❌ | needs [inspected window](INSPECTED-WINDOW.md) (`Runtime.evaluate`) + RN element-tree selection; Redux-family devtools depend on it |
| `elements.onCreateContextMenu`, `inspectedObject`, `openResource` | ❌ | context-menu events ride the dispatch channel |
| `sources.openInFrontend` | ❌ | jump-to-source; RN DevTools has a Sources-like surface |
| `network.getHAR` | ❌ | see [DEVTOOLS-NETWORK.md](DEVTOOLS-NETWORK.md) |
| `performance.onRecording*` | ❌ | cheap if frontend exposes profiling state |

## Definition of done (Tier 1 slice)

`create` + `onShown/onHidden` + `themeName/themeChanged` behave like Chrome for
UI-only extensions (Redux-style panels, Altair client tab).
