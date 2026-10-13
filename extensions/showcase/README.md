# DevTools Showcase

A "kitchen sink" MV3 DevTools extension: a reference for extension authors and a live smoke
test for this shell. Plain JS/HTML/CSS, no build step. It loads unchanged in real
Chrome/Chromium (`chrome://extensions` > Load unpacked) and in the RN DevTools shell
(drop-in under `extensions/`).

> **Load it in a throwaway Chrome profile.** It is a demo, not something for an everyday
> profile. Its scope is deliberately narrow: host permissions, the content script and the
> `webRequest` observers are limited to `http://127.0.0.1/*` and `http://localhost/*` (the
> local test page). It observes requests on localhost only, counts them in memory and never
> writes a browsed URL to storage. Chrome will still list "Read and change all your data on all
> websites": that warning comes from the `devtools_page`, not from host scope, because any
> extension with a devtools page can evaluate code in whatever page you inspect. That is
> another reason for a throwaway profile.

Every capability is one card in the **Showcase** panel with a live status:

| Badge | Meaning |
| --- | --- |
| works | the API exists and a real round-trip or an observed event succeeded; the card shows the value |
| unsupported here | the API is absent, inert or has no backend on this host (reason shown) |
| failed | the API exists and misbehaved |
| ready | waiting for a button press or an event that has not happened yet |

The panel, devtools page, background worker and options page check for each `chrome.*` API
they use before calling it, and each probe has a 12 s timeout, so a missing or silent API
becomes a card status instead of an exception. A second panel, **Showcase Log**, streams the
background worker's event log over a `runtime.connect` Port.

## Files

| File | Role |
| --- | --- |
| `manifest.json` | MV3: `devtools_page`, `background.service_worker`, `options_ui`, `default_locale`, `content_scripts`, permissions |
| `devtools.js` | creates both panels, wires `ExtensionPanel.onShown/onHidden`, answers pings |
| `panel.js` / `panel.html` | the status cards |
| `log.js` / `log.html` | second panel (Port to the background) |
| `theme.js` | shared theme adoption (`themeName` + `setThemeChangeHandler`) |
| `background.js` | `onInstalled`/`onStartup`, alarms, notifications, downloads, webRequest, messaging |
| `content.js` | content-script bridge target (opt-in on this shell) |
| `options.js` / `options.html` | `options_ui` page (storage.sync + i18n) |
| `_locales/en`, `_locales/pl` | i18n with placeholders, `$1` substitution, locale fallback |

## Notes

- **Theme.** `chrome.devtools.panels.themeName` sets the initial look and
  `panels.setThemeChangeHandler(cb)` (Chrome's real hook; Chrome has no `themeChanged` event)
  follows changes. The card is only "works" after a change was actually observed.
- **`onShown` / `onHidden`.** Counted in the devtools page (the panel page may be recreated
  each time its tab is shown), mirrored to `storage.local`, and shown on the panel.
- **Content-script bridge.** Declared in the manifest, but this shell injects nothing unless
  `DEVTOOLS_CONTENT_SCRIPTS=showcase` is set; the card reports the opt-in state.
- **`tabs` permission.** Declared because this shell gates every `chrome.tabs` call on it;
  real Chrome does not need it for `tabs.get`/`query` (a shell divergence, tracked
  separately).
- **Alarm.** A 30 s one-shot (`delayInMinutes: 0.5`), cleared after it fires.
- **Replies.** Message handlers answer synchronously, as Chrome authors would. On a host that
  settles `sendMessage` on the last leg's answer, a silent peer's empty answer can replace the
  real one; the panel retries only idempotent messages (ping, reports) and then reports a
  lost reply.

Evidence and the per-host results table: `docs/evidence/showcase-extension/README.md`.
