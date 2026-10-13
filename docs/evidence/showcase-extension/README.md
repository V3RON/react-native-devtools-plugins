# Evidence: showcase extension

`extensions/showcase/` run in real Chromium 141 and inside the RN DevTools shell (Electron,
Rozenite frontend, fake CDP). All scripts here are the drivers used; they need only `ws`
(from the repo's `node_modules`).

## Screenshots

| File | Shows |
| --- | --- |
| `chrome-1-showcase-panel.png` | Showcase panel in Chrome DevTools: cards for panels/theme/onShown, inspectedWindow, network, messaging |
| `chrome-5-showcase-panel-lower.png` | same panel scrolled: storage, i18n, alarms, notifications, downloads, permissions, event log |
| `chrome-2-log-panel.png` | second panel ("Showcase Log"), fed over a Port from the service worker |
| `chrome-3-dark-theme.png` | DevTools theme flipped to dark: the panel followed live (`setThemeChangeHandler`) |
| `chrome-4-extensions-page.png`, `chrome-extensions-page.json` | `chrome://extensions`: no Errors button; `chrome.developerPrivate` reports `runtimeErrors: 0`, `manifestErrors: 0` and a registered `EXTENSION_SERVICE_WORKER_BACKGROUND` view |
| `shell-1-showcase-panel.png`, `shell-3-showcase-panel-lower.png` | the same panel inside our shell (dark theme from the frontend) with its status cards |
| `shell-2-log-panel.png` | Showcase Log panel in the shell |
| `chrome-results.json`, `shell-results.json` | each card's final `{state, text}` read from the panel (`window.__showcase.results`) |

## Commands

Ports: Chromium 9252, fake-CDP 9253, Electron 9254, target Chromium 9255.

Real Chromium (target page served on 9253):

```
node target-server.js 9253 &
xvfb-run -a -s "-screen 0 1500x950x24" /opt/pw-browsers/chromium-1194/chrome-linux/chrome --no-sandbox \
  --user-data-dir=<tmp> --load-extension=<abs>/extensions/showcase --disable-extensions-except=<abs>/extensions/showcase \
  --auto-open-devtools-for-tabs --remote-debugging-port=9252 --window-size=1400,900 http://127.0.0.1:9253/ &
node run-chrome.js 9252 .          # undock DevTools, open the panels, press buttons, screenshots, results JSON
node check-extensions-page.js 9252 .
node shot-bottom.js 9252 chrome-5-showcase-panel-lower.png
```

Our shell (target page on 9252):

```
node target-server.js 9252 &
chromium --headless=new --no-sandbox --remote-debugging-port=9255 http://127.0.0.1:9252/ &
node src/tools/fake-cdp.js --chrome-port 9255 --listen-port 9253 --target-url http://127.0.0.1:9252/ &
DEVTOOLS_CDP_BRIDGE=off DEVTOOLS_FRONTEND_URL="http://127.0.0.1:8081/rozenite/rn_fusebox.html?ws=localhost:9253" \
  xvfb-run -a npx electron . --no-sandbox --remote-debugging-port=9254 &
node run-shell.js 9254 . shell
```

## Capability to status

Statuses are the panel's own verdicts (`works` = a real round-trip succeeded). Notes explain
every difference. The cards that need the shell's CDP bridge (eval, network, HAR, webRequest)
cannot be exercised in fake-CDP mode, because the brief's `DEVTOOLS_CDP_BRIDGE=off` leaves
`Runtime.evaluate`/`Network.*` without a backend; the panel reports that instead of faking
data. An attempt to point the shell's own bridge at the headless Chromium attached but
`Network.enable` timed out and `eval` never answered, so that was not used as evidence.

| Capability | Chrome 141 | Our shell (fake CDP) | Notes |
| --- | --- | --- | --- |
| runtime id / manifest / getURL | works | works |  |
| panels.themeName + change hook | works | works |  |
| ExtensionPanel.onShown / onHidden | works | unsupported / degraded | this base does not fire onShown/onHidden yet (landing separately) |
| inspectedWindow.eval | works | unsupported / degraded | CDP bridge is off in fake-CDP mode (`DEVTOOLS_CDP_BRIDGE=off`) |
| inspectedWindow.reload | works | ready (button not pressed / no event yet) | button not pressed in the shell run |
| tabs.get / tabs.query | works | works |  |
| network.onRequestFinished | works | ready (button not pressed / no event yet) | needs the CDP bridge |
| Request.getContent | works | ready (button not pressed / no event yet) | needs the CDP bridge |
| network.getHAR | works | ready (button not pressed / no event yet) | needs the CDP bridge |
| webRequest observers | works | ready (button not pressed / no event yet) | needs the CDP bridge |
| sendMessage panel to background | works | works |  |
| sendMessage panel to devtools page | works | works |  |
| runtime.connect Port | works | works |  |
| onInstalled / onStartup | works | works |  |
| content-script bridge (tabs.sendMessage) | works | unsupported / degraded | `DEVTOOLS_CONTENT_SCRIPTS` unset: content scripts are opt-in |
| storage.local | works | works |  |
| storage.sync | works | works |  |
| storage.session | works | works |  |
| storage.onChanged (same frame) | works | works |  |
| i18n (getMessage, placeholders, @@) | works | unsupported / degraded | `chrome.i18n` not on this base (landing separately) |
| cross-frame storage.onChanged | works | unsupported / degraded | storage events are per-frame on this base (landing separately) |
| alarms | works | works |  |
| notifications | works | unsupported / degraded | Electron reports `Notification.isSupported()` false under Xvfb |
| downloads (JSON save) | works | works |  |
| permissions.contains / getAll | works | works |  |
| options_ui / openOptionsPage | ready (button not pressed / no event yet) | ready (button not pressed / no event yet) | button not pressed in either run |

## Findings worth knowing

- **Chromium 141 has no `chrome.devtools.panels.themeChanged` event.** The real hook is
  `panels.setThemeChangeHandler(cb)` (and it fires twice per change). The showcase tries the
  event spellings first, then the method. A host that only ships `themeChanged` is not
  source-compatible with extensions written for Chrome.
- **`runtime.sendMessage` reply loss in the shell.** `src/main/message-router.js`
  (`resolveDelivery`) assigns `lastResponse` even for an empty answer, so a silent peer that
  concludes after the real responder overwrites its reply with `undefined`. Chrome keeps the
  first real response. The showcase answers asynchronously to be portable, and its panel
  reports a lost reply instead of crashing.
- **`chrome.alarms.create` rejects `delayInMinutes` + `periodInMinutes` together here**, which
  Chrome accepts. The showcase arms with `periodInMinutes` alone.
- Shell counters (`onStartup fired Nx`, alarm count) accumulate across the repeated restarts
  of this session because storage persists.
