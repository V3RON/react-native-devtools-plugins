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

# 2. terminal B — CDP bridge + Electron shell
npm run rn-cdp -- --app devtools-poc   # frontend ⇄ app bridge (port 9223)
npm start                              # opens the DevTools window
```

Then in the app (Expo Go / dev build / simulator): press a button — the request should
show up in the Rozenite Network Activity panel and in the GraphQL Network Inspector /
Altair panels. `app/` wires `@rozenite/metro` (serves the patched frontend this shell
loads, incl. `rozenite/rn_fusebox.html`) and `@rozenite/network-activity-plugin`
(network capture).

Notes:

- `app/` needs a *debuggable* connection to Metro (dev build; Dev Menu →
  "Connect to debugger" if the app doesn't show up in Metro's `/json/list`).
- Ports: `rn-cdp` supports `--metro-port` / `--listen-port`; the shell's frontend URL is
  `DEVTOOLS_FRONTEND_URL` (default `http://127.0.0.1:8081/rozenite/rn_fusebox.html?ws=localhost:9223`).

## What's in the box

- `app/` — Expo test app (SDK 57, blank TS template + Rozenite wiring + REST/GraphQL
  buttons). Its Metro server also serves the patched RN DevTools frontend ("rozenite")
  the Electron shell loads; the frontend itself is not part of this repo.
- "Installed" extensions are unpacked extension folders in `extensions/`, served under
  the custom `rozenite://<extension-id>/...` protocol. Folders whose manifest declares a
  `devtools_page` are scanned, launched and panel-hosted by the shell itself — no
  frontend-fork knowledge required (docs/features/DEVTOOLS-PANELS.md):
  - `extensions/sample-extension/` — minimal panel test case
  - `extensions/graphql/` — GraphQL Network Inspector (unpacked Chrome Web Store build)
  - `extensions/altair/` — Altair GraphQL Client (unpacked Chrome Web Store build)
- `src/tools/fake-cdp.js` — standalone CDP proxy that points the frontend at a real Chrome tab
  instead of an RN app (`npm run fake-cdp`, needs Chrome with `--remote-debugging-port=9222`).
- `src/tools/rn-cdp.js` — the RN sibling: attaches the frontend to a real React Native app
  debuggable through Metro's inspector proxy (`npm run rn-cdp`, needs the app connected to
  Metro; `--metro-port`, `--app`, `--device` filters). Works against any RN app, `app/`
  included; against `../expo56` the same recipe applies (`WITH_ROZENITE=true npx expo start`
  there, then `npm run rn-cdp && npm start` here).

## Repository layout

```
app/            Expo test app (REST + GraphQL buttons, Rozenite-wired Metro server)
src/
├── shared/     cross-realm contracts (IPC channels, rozenite:// scheme + URL helpers)
├── chrome-shim pure chrome.* logic (storage areas, network bridge; deps injected)
├── main/       Electron main process (window, config, extension-server, IPC, state)
├── preload/    frontend-host (InspectorFrontendHost) / extension-frame (chrome.* install)
└── tools/      dev tools (fake-cdp, rn-cdp)
extensions/     "installed extensions" — unpacked extension folders
docs/           documentation — start at docs/README.md or docs/STRUCTURE.md
```

## Documentation

- **[docs/](docs/README.md)** — everything: how it works, per-feature status, API gap
  analysis, roadmap.
- Start with [docs/OVERVIEW.md](docs/OVERVIEW.md) (the idea + what was achieved) and
  [docs/features/README.md](docs/features/README.md) (status of each functionality).
