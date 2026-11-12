# devtools-electron

Experiment: run real **Chrome DevTools Extensions** inside **React Native DevTools** by
hosting the Fusebox frontend in Electron and shimming Chrome's extension-host APIs.

## Quick start (full E2E: Expo app + shell)

The repo ships a test app in `app/` — a fresh Expo SDK 57 app with two buttons (REST +
GraphQL) that generate traffic for the extension panels to catch. To run the whole thing:

```sh
# 0. one-time installs
npm install                 # the Electron shell
npm run app:install         # the Expo app (app/)

# 1. terminal A — Metro for the app, with the patched frontend enabled
npm run app:start           # = WITH_ROZENITE=true expo start (port 8081)

# 2. npm start — the shell picks the app from Metro's /json/list itself
npm start                   # opens the DevTools window
```

Then in the app (Expo Go / dev build / simulator): press a button — the request should
show up in the Rozenite Network Activity panel and in the GraphQL Network Inspector /
Altair panels; the sample extension's **Osudio** panel asserts
`chrome.devtools.inspectedWindow.eval` against the live app. `app/` wires
`@rozenite/metro` (serves the patched frontend this shell loads, incl.
`rozenite/rn_fusebox.html`) and `@rozenite/network-activity-plugin` (network capture).

Notes:

- **The lockfile is security-relevant:** `npm ci` installs exactly what `package-lock.json`
  resolves, so an ageing lock is an n-day exposure, not stale metadata. Refresh `electron` at least
  when the minor moves and run the suite — to the newest patch of the pinned major, and into
  Electron's supported window (the latest three majors), since past that no patch is released at
  all. The pinned 38 major already sits outside that window (38.8.6 is its terminal patch), so the
  jump to a supported major is tracked as its own issue — within-major refresh is the floor, not
  the goal. A Dependabot/Renovate rule scoped to `electron` is the durable version of this
  sentence.
- `app/` needs a *debuggable* connection to Metro (dev build; Dev Menu →
  "Connect to debugger" if the app doesn't show up in Metro's `/json/list`).
- The shell picks the app from Metro's `/json/list` (`src/electron/shell/frontend-target.js`:
  first React Native target, polled until one shows up) and loads the frontend with that
  target's `?ws=`, so the frontend dials Metro's inspector proxy directly. Knobs:
  `DEVTOOLS_METRO_HOST` / `DEVTOOLS_METRO_PORT`, `DEVTOOLS_APP_FILTER` /
  `DEVTOOLS_DEVICE_FILTER`; a `DEVTOOLS_FRONTEND_URL` that already names a `ws=` is loaded as
  it is. The extension host opens its own second CDP session to the same target
  (`src/electron/extensions/internal/cdp/cdp-session.js`), sending the dev server's `Origin`. It
  dials only when Metro's `/json/list` reports
  `reactNative.capabilities.supportsMultipleDebuggers: true` for that target, because a second
  debugger on a target without it would evict the frontend. Without it, CDP-backed extension
  APIs (`inspectedWindow.eval`, `devtools.network`, `webRequest`, content scripts) fail with
  the reason; panels, storage and messaging still work. Upstream dev-middleware reports `false`
  unless its `enableStandaloneFuseboxShell` experiment is on
  ([docs/LIMITATIONS.md](docs/LIMITATIONS.md)). The shell opens no listening socket for CDP.
- Every renderer runs sandboxed, so each preload is one bundled file
  (`scripts/bundle-preload.js`, output in gitignored `dist/` folders). `npm start` rebuilds
  both bundles at startup; `npm run build:preload` builds them by hand.
- `chrome.i18n` follows Electron's UI locale (`npm start -- --lang=pt-BR`, or the OS language);
  `DEVTOOLS_UI_LOCALE=ar` overrides it for extensions only. The sample extension ships
  `_locales` for en, pt_BR, de and ar ([docs/features/STORAGE-AND-I18N.md](docs/features/STORAGE-AND-I18N.md)).
- Want a Chrome tab as the target? Run `npm run fake-cdp` and point the frontend at it:
  `DEVTOOLS_FRONTEND_URL='http://127.0.0.1:8081/rozenite/rn_fusebox.html?ws=localhost:9223'`.
  The shell's frontend URL defaults to `http://127.0.0.1:8081/rozenite/rn_fusebox.html` (no
  `ws=`, so the shell picks the target as above).

## What's in the box

- `app/` — Expo test app (SDK 57, blank TS template + Rozenite wiring + REST/GraphQL
  buttons). Its Metro server also serves the patched RN DevTools frontend ("rozenite")
  the Electron shell loads; the frontend itself is not part of this repo.
- "Installed" extensions are unpacked extension folders in `extensions/`, served under
  the custom `rozenite://<extension-id>/...` protocol. The shell scans the folder itself —
  no frontend-fork knowledge required:
  - a manifest with `devtools_page` gets a hidden devtools page and its `panels.create`
    calls become real tabs, and `Panel.onShown(window)` / `onHidden` fire as the tab is
    selected / left (docs/features/DEVTOOLS-PANELS.md);
  - a manifest with `background.service_worker` (or legacy `background.scripts`) also gets an
    **always-on background context** — a hidden window per extension running that script
    against the same `chrome.*` shim, with `runtime.onInstalled`/`onStartup` firing
    (docs/features/BACKGROUND-WORKER.md). Worker output is relayed to the shell's terminal,
    prefixed with the extension id.
  - `extensions/sample-extension/` — minimal panel test case (devtools page, no background)
  - `extensions/graphql/` — GraphQL Network Inspector (unpacked Chrome Web Store build)
  - `extensions/altair/` — Altair GraphQL Client (unpacked Chrome Web Store build; its
    background is an ES module)
  - `extensions/showcase/` — "kitchen sink" reference + live smoke test: one status card per
    supported `chrome.*` capability (devtools panels/network/inspectedWindow, messaging, storage,
    i18n, alarms, notifications, downloads, permissions, tabs, webRequest, options page,
    content-script bridge). Plain JS, no build step; loads in real Chrome too
    (extensions/showcase/README.md)
- `src/tools/fake-cdp.js` — standalone CDP proxy that points the frontend at a real Chrome tab
  instead of an RN app (`npm run fake-cdp`, needs Chrome with `--remote-debugging-port=9222`;
  it listens on `:9223`, so the frontend URL needs `?ws=localhost:9223`). It feeds the frontend
  only: the host's own session does not attach, because the tool does not answer like Metro's
  `/json/list`. Against `../expo56`: `WITH_ROZENITE=true npx expo start` there, then
  `DEVTOOLS_METRO_PORT=<port> npm start` here.

## Repository layout

```
app/            Expo test app (REST + GraphQL buttons, Rozenite-wired Metro server)
src/
├── shared/     cross-realm contracts (IPC channels, rozenite:// scheme + URL helpers)
├── chrome-shim pure chrome.* logic (storage areas, network bridge; deps injected)
├── main/       Electron main process (window, config, extension-server, IPC, state)
├── preload/    frontend-host (InspectorFrontendHost) / extension-frame (chrome.* install)
└── tools/      dev tools (fake-cdp)
extensions/     "installed extensions" — unpacked extension folders
docs/           documentation — start at docs/README.md or docs/STRUCTURE.md
```

## Documentation

- **[docs/](docs/README.md)** — everything: how it works, per-feature status, API gap
  analysis, roadmap.
- Start with [docs/OVERVIEW.md](docs/OVERVIEW.md) (the idea + what was achieved) and
  [docs/features/README.md](docs/features/README.md) (status of each functionality).
- Want the remaining work, with anything that can't exist in React Native DevTools already
  removed? [docs/ROADMAP.md → "What we can actually implement"](docs/ROADMAP.md#what-we-can-actually-implement-the-pruned-list).
  APIs marked 🚷 there and across the docs have no anchor in RN DevTools (no Elements panel,
  no DOM, no page, no browser chrome) and are closed, not deferred.
