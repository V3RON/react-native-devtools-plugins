# Evidence: `Panel.onShown` / `onHidden`

Real run of the production shell: Electron (Xvfb) hosting the patched Rozenite frontend from the
shared Metro server, a fake CDP target in front of headless Chromium, and the bundled
`extensions/sample-extension`. Its devtools page (`devtools.js`) logs each event and writes
it into the **panel's own DOM** through the `window` that `onShown` receives, so the lists in
the screenshots are rendered by the devtools page into the panel page.

Driven over CDP with real mouse events (`Input.dispatchMouseEvent`) on the tab headers, not by
calling frontend APIs. The viewport is set to 1100x520 so the Osudio tab is not in the overflow menu.

## Files

| file | shows |
| --- | --- |
| `1-osudio-shown.png` | the **Osudio** tab selected; the panel page loaded (`Panel events` section below the checks) |
| `2-other-hidden.png` | the **Network** tab selected: Osudio is hidden, so its devtools page received `onHidden` |
| `4-final-log.png` | after Osudio -> Network -> Osudio -> Network -> Osudio: the panel lists `onShown (window: rozenite://sample-extension/panel.html)`, `onHidden`, `onShown`, `onHidden`, `onShown`, i.e. five events in order, each `onShown` carrying a live, same-origin window (the page wrote into it) |
| `5-after-frontend-reload.png` | the same after a **frontend reload** (`Page.reload`): the devtools page is recreated, `panels.create` dedupes against the replayed tab, and events keep flowing to the new devtools page (`onShown`, `onHidden`, `onShown`) |
| `console.txt` | the devtools page's console as captured over CDP (`Runtime.consoleAPICalled`): `[panel-events] ...` lines before and after the reload |

Note the panel page itself reloads on each show (DevTools detaches a hidden tab's content), which
is why the devtools page keeps the history and re-renders it into each fresh window. That is a
pre-existing divergence from Chrome, documented in `docs/features/DEVTOOLS-PANELS.md`.

## Commands

```sh
# inspected target
chrome --headless=new --no-sandbox --remote-debugging-port=9232 \
  --user-data-dir=<tmp> "data:text/html,<title>target</title>hello" &
node src/tools/fake-cdp.js --chrome-port 9232 --listen-port 9233 \
  --target-url "data:text/html,<title>target</title>hello" &
# the shell (--no-sandbox only because the sandbox runs as root)
DEVTOOLS_CDP_BRIDGE=off \
DEVTOOLS_FRONTEND_URL="http://127.0.0.1:8081/rozenite/rn_fusebox.html?ws=localhost:9233" \
  xvfb-run -a -s "-screen 0 1400x900x24" npx electron . --no-sandbox --remote-debugging-port=9234 &
```

The driver attached to `http://127.0.0.1:9234` (the frontend page and the sample extension's
devtools page), set `Emulation.setDeviceMetricsOverride` to 1100x520, clicked
`tab-ext.sample-extension.panel.html` and `tab-network` through the shadow DOM with
`Input.dispatchMouseEvent`, captured `Page.captureScreenshot`, then reloaded the frontend and repeated.
