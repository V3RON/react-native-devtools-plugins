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
  the custom `rozenite://<extension-id>/...` protocol:
  - `extensions/sample-extension/` — minimal panel test case
  - `extensions/graphql/` — GraphQL Network Inspector (unpacked Chrome Web Store build)
  - `extensions/altair/` — Altair GraphQL Client (unpacked Chrome Web Store build)
- `fake-cdp.js` — standalone CDP proxy that points the frontend at a real Chrome tab
  instead of an RN app (`node fake-cdp.js`, needs Chrome with `--remote-debugging-port=9222`).

## Documentation

- **[docs/](docs/README.md)** — everything: how it works, per-feature status, API gap
  analysis, roadmap.
- Start with [docs/OVERVIEW.md](docs/OVERVIEW.md) (the idea + what was achieved) and
  [docs/features/README.md](docs/features/README.md) (status of each functionality).
