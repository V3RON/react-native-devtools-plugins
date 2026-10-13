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
| `chrome-3-dark-theme.png` | DevTools theme flipped to dark: the panel followed live (`setThemeChangeHandler`); the theme card turns "works" only after that observed change |
| `chrome-4-extensions-page.png`, `chrome-extensions-page.json` | `chrome://extensions`: no Errors button; `chrome.developerPrivate` reports `runtimeErrors: 0`, `manifestErrors: 0` and a registered `EXTENSION_SERVICE_WORKER_BACKGROUND` view |
| `shell-1-showcase-panel.png`, `shell-3-showcase-panel-lower.png` | the panel inside the integration shell (frontend dark theme): theme, onShown/onHidden, i18n and cross-frame storage cards all "works" |
| `shell-2-log-panel.png`, `shell-4-flipped-theme.png` | Showcase Log panel; the frontend theme flipped mid-run (the panel followed) |
| `shell-pl-1..4-*.png`, `shell-pl-results.json` | same run with `--lang=pl`: Polish tab titles, manifest name and strings |
| `chrome-results.json`, `shell-results.json` | each card's final `{state, text}` read from the panel (`window.__showcase.results`) |

## Commands

Prerequisite for the shell: the patched frontend must be served on 8081 (Metro:
`npm run app:start`, which serves `/rozenite/rn_fusebox.html`). Real Chromium needs none of that.

Ports used here: Chromium 9252, fake-CDP 9253, Electron 9254, target Chromium 9255.

Real Chromium (target page served on 9253). `launch-chrome.sh` takes `CHROME_BIN` or discovers
a Playwright Chromium / `chromium` / `google-chrome`, and uses a throwaway profile:

```
node target-server.js 9253 &
CHROME_BIN=/path/to/chrome ./launch-chrome.sh 9252 http://127.0.0.1:9253/ &
node run-chrome.js 9252 .          # undock DevTools, open the panels, Reload, then the buttons, theme flip, screenshots, results JSON
node check-extensions-page.js 9252 .
node shot-bottom.js 9252 chrome-5-showcase-panel-lower.png
```

Our shell (target page on 9252; `$CHROME_BIN` as above):

```
node target-server.js 9252 &
$CHROME_BIN --headless=new --no-sandbox --remote-debugging-port=9255 http://127.0.0.1:9252/ &
node src/tools/fake-cdp.js --chrome-port 9255 --listen-port 9253 --target-url http://127.0.0.1:9252/ &
DEVTOOLS_CDP_BRIDGE=off DEVTOOLS_FRONTEND_URL="http://127.0.0.1:8081/rozenite/rn_fusebox.html?ws=localhost:9253" \
  xvfb-run -a npx electron . --no-sandbox --remote-debugging-port=9254 &    # --no-sandbox is needed as root
node run-shell.js 9254 . shell
```

The runners press Reload before Save HAR so the HAR is not empty (real Chrome names the saved
file `showcase (N).json`; its `log.entries` has the five page requests).

## What the shell evidence was captured on

The shell screenshots and results (`shell-*`, `shell-pl-*`) are from a **local, unpushed
integration build** of everything that ships this session, with the showcase on top:

| Merged in this order | Commit |
| --- | --- |
| `origin/main` | `de93aeb` |
| `origin/claude/magical-pascal-49cizm-panel-events` (theme #14 + electron-leftovers #15 + panel events #17) | `47c8761` |
| `origin/claude/magical-pascal-49cizm-storage-session` (#16) | `c6ca01e` |
| `origin/claude/magical-pascal-49cizm-i18n` (#18) | `dcc2382` |
| `claude/magical-pascal-49cizm-showcase-extension` | this branch |

The Chrome evidence (`chrome-*`) is independent of the shell. `shell-pl-*` is the same run
with `--lang=pl DEVTOOLS_UI_LOCALE=pl`. The runner flips the frontend theme during the run
(`shell-4-flipped-theme.png`) so the theme card observes a real change. On plain `main`
(before these branches) `onShown`, theme change, `i18n` and cross-frame storage events were
all unsupported here; they are now "works".

## Capability to status

Statuses are the panel's own verdicts (`works` = a real round-trip or an observed event).
The cards that need the shell's CDP bridge (eval, reload, network, HAR, webRequest) cannot be
exercised in fake-CDP mode, because the brief's `DEVTOOLS_CDP_BRIDGE=off` leaves
`Runtime.evaluate`/`Network.*` without a backend; the panel says so instead of faking data.
I also tried the shell's own bridge against the headless Chromium (a fake Metro `/json/list`
served by `target-server.js <port> <chrome-port>`, `DEVTOOLS_METRO_PORT=<port>`): it attaches,
but `Network.enable` through it times out after 5 s and `eval` never answers, although the
same calls succeed directly against Chromium, so that run is not used as evidence.

| Capability | Chrome 141 | Our shell, integration (fake CDP) | Notes |
| --- | --- | --- | --- |
| runtime id / manifest (`__MSG_` name) / getURL | works | works | also works under `--lang=pl` (Polish strings in `shell-pl-*`) |
| panels.themeName + setThemeChangeHandler (change observed) | works | works |  |
| ExtensionPanel.onShown / onHidden | works | works |  |
| inspectedWindow.eval | works | unsupported / degraded | needs the shell CDP bridge; `DEVTOOLS_CDP_BRIDGE=off` in fake-CDP mode (bridge-on attempt below) |
| inspectedWindow.reload | works | unsupported / degraded | needs the CDP bridge to reload and to confirm; the card also resets when the shell recreates the panel page |
| tabs.get / tabs.query | works | works |  |
| network.onRequestFinished | works | ready (not pressed / no event yet) | needs the CDP bridge |
| Request.getContent | works | ready (not pressed / no event yet) | needs the CDP bridge |
| network.getHAR | works | ready (not pressed / no event yet) | needs the CDP bridge |
| webRequest observers | works | ready (not pressed / no event yet) | needs the CDP bridge |
| sendMessage panel to background | works | unsupported / degraded | shell router: a silent peer's empty answer replaces the real reply (tracked separately); same message works to the devtools page, and the Port works |
| sendMessage panel to devtools page | works | works |  |
| runtime.connect Port | works | works |  |
| onInstalled / onStartup | works | works |  |
| content-script bridge (tabs.sendMessage) | works | unsupported / degraded | `DEVTOOLS_CONTENT_SCRIPTS` unset: content scripts are opt-in by design |
| storage.local | works | works |  |
| storage.sync | works | works |  |
| storage.session | works | works |  |
| storage.onChanged (same frame) | works | works |  |
| i18n (getMessage, placeholders, @@, fallback) | works | works | also works under `--lang=pl` (Polish strings in `shell-pl-*`) |
| cross-frame storage.onChanged (background + devtools page hear a panel write) | works | works |  |
| alarms (one-shot) | works | works |  |
| notifications | works | unsupported / degraded | Electron reports `Notification.isSupported()` false under Xvfb |
| downloads (JSON save) | works | works |  |
| permissions.contains / getAll | works | works |  |
| options_ui / openOptionsPage | ready (not pressed / no event yet) | ready (not pressed / no event yet) |  |

## Findings worth knowing

- **Chromium 141 has no `chrome.devtools.panels.themeChanged` event.** The real hook is
  `panels.setThemeChangeHandler(cb)` (it fires twice per change; the showcase de-duplicates).
  The showcase uses only that; the shell now provides it (theme PR) and the card observes a change.
- **`runtime.sendMessage` reply loss in the shell (visible in the `msg-bg` card, and intermittently
  `msg-dev`: with more extension pages open, which silent peer concludes last varies by run).**
  `src/main/message-router.js` (`resolveDelivery`) assigns `lastResponse` even for an empty
  answer, so a silent peer that concludes after the real responder overwrites its reply with
  `undefined`. Chrome keeps the first real response. The cross-frame storage card therefore
  reports what each context heard through storage, not through a reply. The handlers answer synchronously like a
  Chrome author would; the panel retries only idempotent messages and then reports the lost
  reply. Fix is tracked separately.
- **`chrome.alarms.create` rejects `delayInMinutes` + `periodInMinutes` together here**, which
  Chrome accepts. The showcase uses a one-shot `delayInMinutes` only.
- **`tabs` permission** is declared only because the shell gates all of `chrome.tabs` on it
  (Chrome does not require it for `tabs.get`/`query`). Shell divergence, tracked separately.
- Shell counters (`onStartup fired Nx`) accumulate across restarts because storage persists.
