# devtools-electron

Experiment: run real **Chrome DevTools Extensions** inside **React Native DevTools** by
hosting the Fusebox frontend in Electron and shimming Chrome's extension-host APIs.

Quick start:

```sh
npm install
npm start          # opens a window loading the RN DevTools frontend from Metro (port 8081)
```

- The frontend itself is a patched RN DevTools fork served from a Metro dev server —
  it is not part of this repo.
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
  Metro; `--metro-port`, `--app`, `--device` filters). Against `../expo56`:
  `WITH_ROZENITE=true npx expo start` there, then `npm run rn-cdp && npm start` here.

## Repository layout

```
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
