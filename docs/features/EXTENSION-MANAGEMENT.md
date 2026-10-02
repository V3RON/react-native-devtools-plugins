# Extension management & manifest support

| | |
| --- | --- |
| **Status** | 🟨 partial — scan (devtools pages **and** backgrounds) + manifest parse + per-extension CSP + permission enforcement + an install/version record in the shell; no lifecycle UI |
| **Tier** | 1 |
| **Blocked by** | — |

## What Chrome does

Parses `manifest.json`, assigns an extension id, installs/enables/reloads extensions,
exposes them at `chrome-extension://<id>/`, and drives each declared execution context
(devtools page, background worker, content scripts, action popup…).

## Current state here

- Manifest loading (`extension-server.loadManifest`) + scan/enumeration
  (`src/main/extensions.js`): folders with `devtools_page` get a hidden devtools page
  and their `panels.create` calls become real tabs — no fork knowledge anywhere
  ([DEVTOOLS-PANELS.md](DEVTOOLS-PANELS.md)).
- "Install" = drop the folder in `extensions/`; the frontend picks it up on (re)load.
  The `rozenite://` protocol blindly maps
  `rozenite://<dir-name>/<path>` → `extensions/<dir-name>` (with a path-traversal
  guard; see `src/main/extension-server.js`).
- Extension id == directory name (works, and `runtime.getURL` consumers like Altair's
  `tabs.js` depend on hostname == id — keep it).
- **Per-extension CSP**: `src/shared/csp.js` turns `content_security_policy` into the
  header every `rozenite://` response carries. No declaration ⇒ Chrome's MV3 default
  (`script-src 'self'; object-src 'self'`, plus `wasm-unsafe-eval` for service-worker
  extensions). A declaration that weakens `script-src`/`object-src` is not served — the
  strict default is, with one console line naming the extension and the reason.
- **Declared permissions gate capability.** Two enforcement points, both asserted in
  `tests/extension-frame-electron.test.js`: `src/main/delivery-scope.js` filters host→frame
  deliveries using the manifest read **from disk** (a frame cannot talk itself into data),
  and `src/chrome-shim/permission-gate.js` makes the promise/callback APIs answer with
  `runtime.lastError` + a rejected promise. Only `permissions` counts, like Chrome's
  `permissions.contains()` — `host_permissions` is network reach, `optional_permissions`
  are by definition not granted.
- **Background contexts are discovered and run.** `scanBackgroundExtensions()`
  (`src/main/extensions.js`) lists folders declaring `background.service_worker` or a
  non-empty `background.scripts` — independently of the devtools-page scan, so an extension
  with both is hosted twice, as Chrome does. The host also remembers which extension
  **versions** it has seen (`src/main/install-state.js`, `electron-store` under `userData`);
  that is what turns "the manifest's version changed" into `runtime.onInstalled`
  (`install` / `update`) versus `onStartup`. It is the closest thing this shell has to an
  install record, and a fresh `--user-data-dir` correctly looks like a fresh install.
- Deviation worth stating: Chrome does not inject an undeclared namespace at all
  (`chrome.tabs === undefined`); this shell keeps the shape and fails the call, per the
  shape-first stubbing rule in [OVERVIEW.md](../OVERVIEW.md).

## Needed

- Install/uninstall/reload: folder watcher for dev ergonomics + lifecycle UI.
- ~~Per-extension CSP enforcement on the `rozenite:` frames~~ ✅ done — every
  `rozenite://` response carries the extension's own policy, or Chrome's MV3 default
  (`src/shared/csp.js`), and an inline `<script>` in an extension page is refused.
- Enforce more than the shape: a declared permission now gates real capability
  (`src/main/delivery-scope.js` + `src/chrome-shim/permission-gate.js`); `optional_permissions`
  and a real `chrome.permissions.request` prompt are still open.

## Manifest key support matrix

| Manifest key | Verdict |
| --- | --- |
| `manifest_version: 3`, `name`, `version`, `description`, `icons` | Parse and honor |
| `devtools_page` | **Core** — spawn hidden frame per extension |
| `background.service_worker` / `background.scripts` | **Run** as an always-on hidden context (`src/main/background-host.js`), honoring `type: "module"`; `service_worker` wins over `scripts[0]` → [BACKGROUND-WORKER.md](BACKGROUND-WORKER.md) |
| `storage`, `alarms`, `notifications` permissions | Declared ⇒ granted, and now **enforced**: an undeclared API fails the call instead of working |
| `host_permissions`, `webRequest` | `webRequest` enforced at the transport (deliveries are scoped to the declaration in `src/main/delivery-scope.js`); `host_permissions` still grant nothing beyond the RN app's own CDP reach |
| `content_scripts` | Runner per [CONTENT-SCRIPTS.md](CONTENT-SCRIPTS.md) (bridge-style only) |
| `action`, `commands`, `contextMenus`, `omnibox`, `side_panel` | Accept; no-op shells |
| `options_ui` | Open in a separate Electron window |
| `content_security_policy` | **Honored per extension** on `rozenite://` responses (`src/shared/csp.js`); no declaration ⇒ Chrome's MV3 default, a weakening declaration ⇒ the strict default plus one console line |
| `web_accessible_resources` | Meaningful mainly for injected content scripts; serve files under the protocol anyway |
| `permissions: tabs/identity/...` | Report granted; APIs themselves per [TIER3-OMITTED.md](TIER3-OMITTED.md) and feature docs |

## Open questions

- Id strategy: hash of contents vs. folder name (stable debugging URLs vs. simplicity).
- Where installed extensions live (userData dir, multiple roots, dev-mode watch).
