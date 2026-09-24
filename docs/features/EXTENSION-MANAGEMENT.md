# Extension management & manifest support

| | |
| --- | --- |
| **Status** | 🟨 partial — scan + manifest parse + panel hosting in the shell; no lifecycle UI |
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

## Needed

- Install/uninstall/reload: folder watcher for dev ergonomics + lifecycle UI.
- Per-extension CSP enforcement on the `rozenite:` frames (today: security fully off).

## Manifest key support matrix

| Manifest key | Verdict |
| --- | --- |
| `manifest_version: 3`, `name`, `version`, `description`, `icons` | Parse and honor |
| `devtools_page` | **Core** — spawn hidden frame per extension |
| `background.service_worker` | Run as always-on hidden Electron frame → [BACKGROUND-WORKER.md](BACKGROUND-WORKER.md) |
| `storage`, `alarms`, `notifications` permissions | Accept silently (always granted) |
| `host_permissions`, `webRequest` | Accept; enforce nothing beyond the RN app's own CDP reach |
| `content_scripts` | Runner per [CONTENT-SCRIPTS.md](CONTENT-SCRIPTS.md) (bridge-style only) |
| `action`, `commands`, `contextMenus`, `omnibox`, `side_panel` | Accept; no-op shells |
| `options_ui` | Open in a separate Electron window |
| `content_security_policy` | Honor per-extension frame CSP (currently the opposite) |
| `web_accessible_resources` | Meaningful mainly for injected content scripts; serve files under the protocol anyway |
| `permissions: tabs/identity/...` | Report granted; APIs themselves per [TIER3-OMITTED.md](TIER3-OMITTED.md) and feature docs |

## Open questions

- Id strategy: hash of contents vs. folder name (stable debugging URLs vs. simplicity).
- Where installed extensions live (userData dir, multiple roots, dev-mode watch).
