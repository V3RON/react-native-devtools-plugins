# Evidence: `chrome.devtools.panels.themeName` / `themeChanged`

The bundled sample extension's "Osudio" panel (`extensions/sample-extension/panel.js`)
renders `chrome.devtools.panels.themeName` on the line under the heading, paints its own
background from it, and logs every `themeChanged`. Screenshots are of the real Electron
window (Rozenite frontend from Metro, fake CDP backend), captured with
`Page.captureScreenshot`; the theme was switched through the frontend's own `ui-theme`
setting (the one Settings -> Preferences -> Theme edits).

| File | Shows |
| --- | --- |
| `1-boot-dark.png` | Frontend booted with `ui-theme = dark`: panel says `themeName = dark (at load)` |
| `2-switched-to-light.png` | Setting switched to `default`: panel line reads `default (themeChanged)` |
| `3-switched-back-to-dark.png` | Switched back to `dark` |
| `4-boot-light.png` | Frontend reloaded with `ui-theme = default`: `themeName = default (at load)`. Weak evidence on its own: "default" is also what an extension sees with no host input at all; the boot-dark shot is the one that distinguishes |
| `5-system-dark.png` / `6-system-light.png` | `ui-theme = systemPreferred`, `prefers-color-scheme` emulated dark then light: the panel follows the system flip. The yellow caption (added by the driver, not product UI) prints the live `ui-theme` value and the emulated media |
| `log.json` / `log-system.json` | Per step: frontend's `theme-with-dark-background` class, the panel's `themeName`, and the panel's console `[theme]` lines (including the `themeChanged -> <name>` events) |

## Commands

```sh
# inspected target (headless Chromium) + fake CDP backend
chrome --headless=new --no-sandbox --remote-debugging-port=9222 \
  "data:text/html,<title>target</title><h1>inspected</h1>" &
node src/tools/fake-cdp.js --chrome-port 9222 --listen-port 9223 \
  --target-url "data:text/html,<title>target</title><h1>inspected</h1>" &
# the shell (root needs --no-sandbox, hence the wrapper that appends it)
DEVTOOLS_CDP_BRIDGE=off \
DEVTOOLS_FRONTEND_URL="http://127.0.0.1:8081/rozenite/rn_fusebox.html?ws=localhost:9223" \
  xvfb-run -a electron . --remote-debugging-port=9224 &
```

Both drivers are committed: `drive.js` (setting switches, reloads: shots 1-4) and
`drive-system.js` (shots 5-6). Run with the frontend stack above up:
`NODE_PATH=<repo>/node_modules node docs/evidence/panels-theme/drive.js docs/evidence/panels-theme`
(it writes its PNGs and `log*.json` into the directory given).

The driver connected to `localhost:9224` over CDP, opened the panel with
`InspectorView.showPanel("ext.sample-extension.panel.html")`, set the theme with
`Common.Settings.Settings.instance().moduleSetting("ui-theme").set(...)`, emulated the
system theme with `Emulation.setEmulatedMedia`, and read the panel frame's
`chrome.devtools.panels.themeName` / console over its own CDP target.
