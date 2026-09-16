# Extension management & manifest support

| | |
| --- | --- |
| **Status** | 🟡 stub — "extension = folder at repo root" |
| **Tier** | 1 |
| **Blocked by** | — |

## What Chrome does

Parses `manifest.json`, assigns an extension id, installs/enables/reloads extensions,
exposes them at `chrome-extension://<id>/`, and drives each declared execution context
(devtools page, background worker, content scripts, action popup…).

## Current state here

- No manifest parsing at all. The `rozenite://` protocol blindly maps
  `rozenite://<dir-name>/<path>` → repo-root folder (`main.js`).
- The installed set is implicit (which folders exist) and the frontend fork must know the
  ids; no install/uninstall/reload UI.
- Extension id == directory name (works, and `runtime.getURL` consumers like Altair's
  `tabs.js` depend on hostname == id — keep it).

## Needed

- Manifest loader: parse + validate MV3, synthesize a stable id, registry with
  install/uninstall/reload (watch folder for dev ergonomics).
- Enumerate extensions to the frontend (replacing hardcoded fork knowledge).
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
