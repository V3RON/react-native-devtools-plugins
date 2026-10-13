# Evidence: `openInNewTab`, `save`/`append`, `getHostConfig`

Real shell (Electron under Xvfb) + the real RN DevTools frontend from Metro, attached through
`src/tools/fake-cdp.js` to a headless Chromium page, driven over CDP by `drive.js`. No emulators:
menus are real right-clicks and clicks on the frontend's own (soft) context menus, buttons are real
mouse events.

## Reproduce

Ports 9292-9296 only: 9292 inspected Chromium, 9293 fake-cdp, 9294 Electron, 9295 target page.
Metro is already serving `http://127.0.0.1:8081/rozenite/rn_fusebox.html`.

```sh
# 1. a page that keeps logging and fetching (target.html), served on 9295
mkdir site && cp docs/evidence/electron-leftovers/target.html site/index.html
echo '{"ok":true,"n":42}' > site/data.json
(cd site && python3 -m http.server 9295 --bind 127.0.0.1 &)
# 2. the inspected target
/opt/pw-browsers/chromium-1194/chrome-linux/chrome --headless=new --no-sandbox \
  --remote-debugging-port=9292 --user-data-dir=$PWD/chrome-profile http://127.0.0.1:9295/ &
# 3. the CDP relay
node src/tools/fake-cdp.js --chrome-port 9292 --listen-port 9293 --target-url http://127.0.0.1:9295/ &
# 4. a dir holding an `electron` wrapper that adds --no-sandbox (running as root)
mkdir wrap && printf '#!/bin/sh\nexec %s/node_modules/electron/dist/electron --no-sandbox "$@"\n' "$PWD" > wrap/electron && chmod +x wrap/electron
# 5. launches the shell three times (Electron on 9294) and drives it
node docs/evidence/electron-leftovers/drive.js "$PWD/wrap" "$PWD/out"
```

The three launches differ only in environment:

| Run | Environment | Proves |
| --- | --- | --- |
| A | `DEVTOOLS_TEST_SAVE_DIALOG=<out>/saved DEVTOOLS_TEST_OPEN_LOG=<out>/open.log` | save/append/close, savedURL/appendedToURL, HAR export, openInNewTab, default host config |
| B | `DEVTOOLS_TEST_SAVE_DIALOG=cancel` | canceledSaveURL, nothing written |
| C | `DEVTOOLS_HOST_CONFIG='{"aidaAvailability":{"enabled":true},"devToolsConsoleInsights":{"enabled":true},"devToolsFreestyler":{"enabled":true}}'` | the host config reaches the UI |

Both seams are off unless the variable is set. `lib.js` is the launch/CDP helper; `results.json`
is what the driver observed (paths shortened to `<outDir>`).

## Files

| File | What it shows |
| --- | --- |
| `01-default-host-config.png` | default host config: the drawer has only the **Console** tab (no "AI assistance"). Taken with the page's live console output. |
| `02-network-panel.png` | Network panel with the inspected page's real requests, the state from which the HAR is exported. |
| `03-saved-console-log.png` | the file Console **Save as…** wrote to disk (right-click a message, click "Save as…"), rendered from `console-save-as.txt` — the page's real log lines, written by `save('<host>-<ts>.log','')` then `append(…)` then `close`. |
| `04-ai-config-override.png` | run C: same shell, `DEVTOOLS_HOST_CONFIG` turns AIDA on and the **AI assistance** drawer tab appears (compare `01`). |
| `console-save-as.txt` | the saved console text (21 lines). |
| `network-save-as.har` | the HAR written by the toolbar's "Export HAR (sanitized)…": valid JSON, 6 entries (`GET http://127.0.0.1:9295/`, `…/data.json?n=1`, …). |
| `results.json` | machine-readable observations, below. |

## What `results.json` records

- `consoleEvents` / `harEvents`: the frontend received `savedURL(url, fileSystemPath)` then
  `appendedToURL(url)` for the url it passed to `save` (`127.0.0.1-<ts>.log`, `127.0.0.1.har`) — the
  events its `FileManager` waits for. Before this change none of them could arrive: the dispatch
  channel's `executeInMainWorld({arguments})` bug (it must be `args`) dropped every event.
- `consoleCalls`: the frontend's call sequence `save` → `append` → `close` (content lengths shown).
- `cancelEvents` / `cancelFilesWritten`: dialog cancelled -> `canceledSaveURL`, directory empty.
- `rowMenuEntry` / `openLogAfterRowMenu`: a request row's "Open in new tab" produced
  `http://127.0.0.1:9295/` in the open log; no browser was launched (the opener is the test seam).
- `openLog` vs `openRefusals`: `https://…` and `http://localhost…` were opened; `file:///etc/passwd`,
  `javascript:alert(1)`, `smb://host/share`, `ms-msdt:/id` and `not a url` were refused in main and
  logged in the frontend console. Nothing but the two allowed URLs and the row URL is in the log.
- `hostConfig` (default) and `overrideAida`: what `getHostConfig` returned in runs A and C.
- `drawerTabsDefault` vs `drawerTabsOverride`: every `[role=tab]` in the frontend; only run C has
  "AI assistance".

Unrelated to this change: the "Failed to wait for initialization: it took too long" error behind the
drawer in the screenshots is the Rozenite panel failing to find an RN device in this fake-CDP setup.
`console-save-as.txt` is `.txt` only because `*.log` is gitignored; the shell wrote a `.log`.

## Not covered

- A real `shell.openExternal` launch (no browser is started in the container); the refusal and the
  call are proven, the OS hand-off is Electron's.
- The native save dialog itself (answered by the seam); the dialog code path is the pre-existing
  `dialog.showSaveDialog` in `src/main/save-service.js`.
- An AI conversation: only the gate (tab present/absent) is shown.
