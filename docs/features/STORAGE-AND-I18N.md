# Storage & i18n (`chrome.storage`, `chrome.i18n`)

| | |
| --- | --- |
| **Status** | 🟨 storage real for local/sync; i18n missing |
| **Tier** | 1 |
| **Blocked by** | — |

## `chrome.storage` — the success story ✅ (mostly)

`src/chrome-shim` implements the StorageArea contract backed by `electron-store` (one
JSON file per extension per area): `get/set/remove/clear/getBytesInUse/getKeys`,
`QUOTA_BYTES`, `onChanged` with proper `{oldValue, newValue}` semantics, promise **and**
callback styles. This is why GraphQL Network Inspector's settings persist.

Remaining gaps:

| Area | Status | Plan |
| --- | --- | --- |
| `local` | ✅ | — |
| `sync` | 🟨 | keep as alias of local (no Chrome Sync exists); document divergence |
| `session` | ❌ | in-memory Map + same contract — Altair's `tabs.js` uses `storage.session` |
| `managed` | ❌ | read-only empty object (optional) |
| `StorageArea.getKeys` | ✅ (ahead of Chrome) | — |
| cross-frame `onChanged` | ❌ | today change events fire in the writing frame only; broadcast via the messaging router ([RUNTIME-MESSAGING.md](RUNTIME-MESSAGING.md)) |

## `chrome.i18n` — missing ❌

Chrome: `getMessage(name, substitutions?)` reading `_locales/<lang>/messages.json`
(+ `@@extension_id` special case), `getUILanguage`, `acceptLanguages`, `detectLanguage`.

Plan: read `_locales/` from the extension folder at manifest-parse time; `getUILanguage`
from Electron locale; `acceptLanguages` → `[ui, 'en-US']`; `detectLanguage` stub. Many
otherwise-simple extensions break on `getMessage` at startup, so this is cheap and
unblocks a lot.

## Definition of done

Altair runs with its real persisted state (session + local) and localized strings.
