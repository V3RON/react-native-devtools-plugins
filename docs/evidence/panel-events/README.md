# Evidence: `Panel.onShown` / `onHidden` and the `showPanel` producer

Real run of the production shell: Electron (Xvfb) hosting the patched Rozenite frontend from the
shared Metro server, a fake CDP target in front of headless Chromium, and the bundled
`extensions/sample-extension`. Its devtools page (`devtools.js`) logs each event and writes it
into the **panel's own DOM** through the `window` that `onShown` receives, so the "Panel events"
list is rendered by the devtools page into the panel page. The shell was started with
`DEVTOOLS_SHOW_PANEL=sample-extension/panel.html`.

Driven by `drive.js` (this folder) over CDP, with real mouse events
(`Input.dispatchMouseEvent`) on the tab headers. Viewport 1100x520 so Osudio is not in the
overflow menu. The panel page is `setHideOnDetach`, so it is **not reloaded** on re-show: the
"Panel page loaded: <time> #<token>" line at its top is set once per document load, and the
event list only grows.

| file | shows |
| --- | --- |
| `1-showpanel-no-click.png` | **Nothing was clicked.** The shell itself selected the Osudio tab through the host -> frontend `showPanel` dispatch (`panelHost.showPanel`, triggered by `DEVTOOLS_SHOW_PANEL`); the panel page is loaded (`Panel page loaded: ... #o71j`) |
| `2-network-selected.png` | the **Network** tab selected: Osudio is hidden, its devtools page received `onHidden` |
| `3-osudio-reshown-same-page.png` | Osudio re-selected: the same panel page (list of events kept and extended, not reset) and `onShown` again |
| `4-showpanel-from-network.png` | from the Network tab, `InspectorFrontendAPI.showPanel("ext.16.sample-extension.panel.html")` (the call the preload's dispatcher makes) switched back to Osudio, and the list shows the full order `onShown, onHidden, onShown, onHidden, onShown`, each `onShown` carrying `window: rozenite://sample-extension/panel.html` |
| `5-after-frontend-reload.png` | after a **frontend reload** (`Page.reload`): the devtools page is recreated, `panels.create` dedupes against the replayed tab, and events flow to the new devtools page (a fresh list: `onShown, onHidden, onShown`) |
| `console.txt` | the devtools page's console as captured over CDP (`Runtime.consoleAPICalled`), before and after the reload |

## Commands

```sh
chrome --headless=new --no-sandbox --remote-debugging-port=9232 --user-data-dir=<tmp> \
  "data:text/html,<title>target</title>hello" &
node src/tools/fake-cdp.js --chrome-port 9232 --listen-port 9233 \
  --target-url "data:text/html,<title>target</title>hello" &
# --no-sandbox only because the sandbox runs as root
DEVTOOLS_SHOW_PANEL=sample-extension/panel.html DEVTOOLS_CDP_BRIDGE=off \
DEVTOOLS_FRONTEND_URL="http://127.0.0.1:8081/rozenite/rn_fusebox.html?ws=localhost:9233" \
  xvfb-run -a -s "-screen 0 1400x900x24" npx electron . --no-sandbox --remote-debugging-port=9234 &
node docs/evidence/panel-events/drive.js docs/evidence/panel-events 9234
```

The automated counterpart (production bridge + preload + host in a real Electron process, with
a fake `legacy.js`) is `tests/panel-events-electron.test.js`.
