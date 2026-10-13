# Evidence: `chrome.storage` shared per extension, with cross-context `onChanged`

Real shell (Electron under Xvfb) hosting the real DevTools frontend, with two demo
extensions from [`fixtures/extensions/`](fixtures/extensions). Each has a devtools page, a
panel, a background worker and an options page, and declares `storage`. Every context
listens to `chrome.storage.onChanged` **on its own** and reports what it heard to the panel
with `runtime.sendMessage`, so each line in a panel's "heard" box came out of that context's
own listener.

Driver: [`drive.js`](drive.js) (+ [`cdp.js`](cdp.js)); it asserts as it goes and exits non-zero
on a failed check. Its output for this run is in [`results.json`](results.json).

## Screenshots

| File | What it proves |
| --- | --- |
| `01-panel-a-initial.png` | Panel of extension A before any write: `chrome.storage.session` is empty. |
| `02-panel-a-background-and-devtools-heard.png` | The panel wrote `session.set({counter: 1, by: "panel"})`. The **background worker** and the **devtools page** (separate frames of the same extension) each fired `chrome.storage.onChanged` (`(absent) -> 1`) and the per-area `storage.session.onChanged`, which carries the changes alone. |
| `03-options-page-a-read-and-heard.png` | The options page (a separate window) opened *after* the first write and **read** `counter` from `chrome.storage.session`; after a second panel write it heard `counter: 1 -> 2` (`oldValue`/`newValue`). |
| `03b-panel-a-all-contexts-heard.png` | The panel's list now holds reports from the worker, the devtools page **and** the options page for the second write. |
| `04-panel-b-sees-nothing-of-a.png` | Panel of a *different* extension, B, right after A's writes: its session storage is `{}` and none of B's contexts heard anything. |
| `05-panel-b-own-write.png` | B writes the same key. Only B's worker and devtools page report it, as `(absent) -> 1` — never `2 -> 1`, so A's value was never visible to B. |
| `06-panel-a-reloaded-reads-shared-value.png` | Switching tabs recreates a panel's frame. The new A panel reads `{counter: 2, by: "panel"}` straight away: the value belongs to the extension (held by main), not to the frame that wrote it, and B's write did not touch it. |
| `07-options-page-a-never-heard-b.png` | After one more write from the new A panel, the options page's list is exactly `1 -> 2`, `2 -> 3`: it heard A's changes only, and B's write in between never reached it. |

The same claims are asserted headlessly in `tests/storage-electron.test.js` (two extensions,
two panels and a worker each, plus the quota error, in a real Electron process).

## Commands used

Ports 9282–9286 only: 9282 inspected Chromium, 9283 fake CDP, 9284 Electron remote debugging.

```sh
# 1. the "inspected target"
/opt/pw-browsers/chromium-1194/chrome-linux/chrome --headless=new --no-sandbox \
  --remote-debugging-port=9282 --user-data-dir=<scratch>/chrome-profile \
  "data:text/html,<title>inspected</title><h1>inspected page</h1>"

# 2. fake CDP relay between it and the frontend
node src/tools/fake-cdp.js --chrome-port 9282 --listen-port 9283 \
  --target-url "data:text/html,<title>inspected</title><h1>inspected page</h1>"

# 3. the shell, pointed at the demo extensions (Metro on :8081 serves the frontend)
DEVTOOLS_CDP_BRIDGE=off \
DEVTOOLS_EXTENSIONS_DIR="$PWD/docs/evidence/storage-session/fixtures/extensions" \
DEVTOOLS_FRONTEND_URL="http://127.0.0.1:8081/rozenite/rn_fusebox.html?ws=localhost:9283" \
xvfb-run -a -s "-screen 0 1500x950x24" npx electron . --no-sandbox \
  --remote-debugging-port=9284 --user-data-dir=<scratch>/electron-data

# 4. drive it and take the screenshots (fresh shell: session storage starts empty)
node docs/evidence/storage-session/drive.js --electron-port 9284 \
  --out docs/evidence/storage-session
```

The frontend viewport is set to 1300x800 with `Emulation.setDeviceMetricsOverride`
(Electron has no `Browser.setWindowBounds`).
