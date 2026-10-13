# DevTools Showcase

A "kitchen sink" MV3 DevTools extension: a reference for extension authors and a live smoke
test for this shell. Plain JS/HTML/CSS, no build step. It loads unchanged in real
Chrome/Chromium (`chrome://extensions` > Load unpacked) and in the RN DevTools shell
(drop-in under `extensions/`).

Every capability is one card in the **Showcase** panel with a live status:

| Badge | Meaning |
| --- | --- |
| works | the API exists and a real round-trip succeeded; the card shows the value |
| unsupported here | the API is absent, inert or has no backend on this host (reason shown) |
| failed | the API exists and misbehaved |
| ready | waiting for a button press or an event |

Everything is feature-detected, so nothing throws on either host. A second panel,
**Showcase Log**, streams the background worker's event log over a `runtime.connect` Port.

## Files

| File | Role |
| --- | --- |
| `manifest.json` | MV3: `devtools_page`, `background.service_worker`, `options_ui`, `default_locale`, `content_scripts`, permissions |
| `devtools.js` | creates both panels, wires `ExtensionPanel.onShown/onHidden`, answers pings |
| `panel.js` / `panel.html` | the status cards |
| `log.js` / `log.html` | second panel (Port to the background) |
| `background.js` | `onInstalled`/`onStartup`, alarms, notifications, downloads, webRequest, messaging |
| `content.js` | content-script bridge target (opt-in on this shell) |
| `options.js` / `options.html` | `options_ui` page (storage.sync + i18n) |
| `_locales/en`, `_locales/pl` | i18n with placeholders, `$1` substitution, locale fallback |

## Notes for host differences

- **Theme.** The panel adopts `chrome.devtools.panels.themeName` (`dark` or light) and updates
  live. Real Chromium exposes the change hook as `panels.setThemeChangeHandler(cb)`; the event
  spelling `themeChanged.addListener` is used when a host has it. Both are tried.
- **`onShown` / `onHidden`.** Counted in the devtools page (the panel page may be recreated
  each time its tab is shown), mirrored to `storage.local`, and shown on the panel.
- **Content-script bridge.** Declared in the manifest, but this shell injects nothing unless
  `DEVTOOLS_CONTENT_SCRIPTS=showcase` is set; the card reports the opt-in state.
- **Replies.** `ping`/report handlers answer asynchronously: when several extension pages hear
  one message, the silent ones conclude at once, and an async answer is the one that arrives last.
- **Alarm.** Armed with `periodInMinutes: 0.5` only (first tick after 30 s).

Evidence and the per-host results table: `docs/evidence/showcase-extension/README.md`.
