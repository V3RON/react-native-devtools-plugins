# Evidence: `chrome.i18n`

Feature write-up: [../../features/STORAGE-AND-I18N.md](../../features/STORAGE-AND-I18N.md).

## Live shell (real Electron shell, real frontend, fake-CDP target)

All four captures come from `drive.js`, which starts everything on ports 9272-9275, opens the
sample extension's panel tab with a real pointer click, reads what the panel rendered from the
panel's own execution context, and takes the screenshot. The tab title is itself the output of
`chrome.i18n.getMessage("panelTitle")` in `extensions/sample-extension/devtools.js`, called on
the first statement of the devtools page — i.e. synchronously, before anything async settled.

| File | What it proves |
| --- | --- |
| `01-en-US.png` / `.json` | Default locale. Tab "Osudio"; greeting built from `$USER$`/`$COUNT$` placeholders + substitutions; `Costs $$5` renders `$5`; UI language `en-US (en_US)`; accept languages `en-US, en`. All panel checks PASS, including the new `chrome.i18n …` check. |
| `02-pt-BR.png` / `.json` | `--lang=pt-BR` (Electron/Chromium's own switch; the frontend even offers to switch itself to Portuguese). Tab "Painel Osudio", heading, labels, greeting and price (`R$$5` → `R$5`) from `_locales/pt_BR`; accept languages `pt-BR, pt, en-US, en`. |
| `03-ar-rtl.png` / `.json` | `DEVTOOLS_UI_LOCALE=ar` (the extension-only override). Arabic strings, tab "لوحة Osudio", **and the CSS file is localized**: `direction: __MSG_@@bidi_dir__` became `rtl` (page mirrored, the green border moved to the start edge via `__MSG_@@bidi_start_edge__`). The `price` and `fallback` lines show Chrome's per-message fallback to `default_locale`. |
| `04-de.png` / `.json` | `--lang=de`. Tab "Osudio-Panel". `price` is not translated in `de`, so the line falls back to the default locale (`Costs $5 per month`) — per-message fallback, not per-file. |

Commands (run from the repo root; Metro must be serving the frontend on 8081, `ws` and
`xvfb-run` installed):

```sh
node docs/evidence/i18n/drive.js 01-en-US
node docs/evidence/i18n/drive.js 02-pt-BR --lang pt-BR
node docs/evidence/i18n/drive.js 03-ar-rtl --env-locale ar
node docs/evidence/i18n/drive.js 04-de --lang de
```

`drive.js` internally runs (ports 9272-9276 are this feature's):

```sh
chromium --headless=new --remote-debugging-port=9272 http://127.0.0.1:9275/        # inspected target
node src/tools/fake-cdp.js --chrome-host 127.0.0.1 --chrome-port 9272 --listen-port 9273 --target-url http://127.0.0.1:9275/
DEVTOOLS_CDP_BRIDGE=off DEVTOOLS_FRONTEND_URL="http://127.0.0.1:8081/rozenite/rn_fusebox.html?ws=localhost:9273" \
  xvfb-run -a -s "-screen 0 1700x900x24" node_modules/.bin/electron . --no-sandbox --remote-debugging-port=9274 [--lang=<tag>]
```

The `.json` next to each image is the machine-readable result: the tab strip, the panel's
rendered lines, `getUILanguage()`, `getAcceptLanguages()`, the panel's own PASS list, the
frontend's Audits issues (empty) and any i18n/deprecation console lines (none) — evidence that
the synchronous bundle read does not surface a console warning.

## Real Chromium reference (`chromium-reference/`)

Ground truth for the message semantics. `cases.js` holds the fixture extensions (messages
catalogs + the `getMessage` calls to make); `ref-case.js` loads one into **real headless
Chromium 141.0.7390.37** with `--load-extension` and reports what `chrome.i18n` answered or the
load error Chromium raised; `ref-batch.js` runs them all; `results.txt` is the recording.

```sh
node docs/evidence/i18n/chromium-reference/ref-batch.js docs/evidence/i18n/chromium-reference/cases.js   # ~3 min
```

`tests/i18n-chromium-parity.test.js` replays every case through this shell's implementation
and compares with `results.txt`. The recording is what found the non-obvious rules (`$` runs
shrink by one, `$x` is dropped with `x`, per-message locale fallback, sorted-last duplicate
wins, `@@` names are not variables inside messages, Chromium's load refusals).
