# Storage & i18n (`chrome.storage`, `chrome.i18n`)

| | |
| --- | --- |
| **Status** | 🟨 storage real for local/sync/session (session: per-frame in-memory) ; i18n missing |
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
| `session` | 🟨 per-frame in-memory — **now a visible behavioral gap**, see below | shared main-process store keyed by `extensionId` |
| `managed` | ❌ | read-only empty object (optional) |
| `StorageArea.getKeys` | ✅ (ahead of Chrome) | — |
| cross-frame `onChanged` | ❌ | today change events fire in the writing frame only; broadcast via the messaging router ([RUNTIME-MESSAGING.md](RUNTIME-MESSAGING.md)) |

### `storage.session` — what the background worker changed about this

Chrome shares `storage.session` across **every context of one extension**; this shell has
always kept it per-frame (`createMemoryBackend()` in `src/chrome-shim/storage.js`, wired by
`src/preload/extension-frame.js`). That used to be nearly invisible because every frame was a
panel or a devtools page, and none of them used it.

The background worker makes the deviation real, and the honest statement is this: **a value a
panel writes to `chrome.storage.session` is not readable by the worker, and vice versa.** No
error is raised on either side — each context reads its own empty area, which is the failure
mode that gets debugged slowly.

The concrete case is Altair, whose `assets/tabs.js` (imported by its background worker) stores
the app tab id there:

```js
const get = async () => (await chrome.storage.session.get(["altairAppTabId"])).altairAppTabId;
const set = async (t) => { await chrome.storage.session.set({ altairAppTabId: t }); };
```

So the worker's own round trip through `session` works — it is one context — but no *other*
context of that extension can observe it. `tabs.create` is inert here anyway
([BACKGROUND-WORKER.md](BACKGROUND-WORKER.md)), so nothing is lost *today* beyond what is
already broken; the point is that `session` is now on the list of things a multi-context
extension can get wrong silently.

**Not fixed here, deliberately.** The clean fix is a main-process session store keyed by
`extensionId` plus `onChanged` fan-out through the router — i.e. making session storage the
first storage area the host owns instead of the frame. That is a real change to storage's
ownership, and half-doing it (a shared map without the change events, or a shared map that
local/sync do not have) would trade a silent-empty-area bug for a silent-stale-listener bug,
which is not an improvement. `local`/`sync` persist through `electron-store` per frame; the
same one-store-per-file race those areas accept is exactly what a host-owned session store
would remove, so it is worth doing together with them.

## `chrome.i18n` — missing ❌

Chrome: `getMessage(name, substitutions?)` reading `_locales/<lang>/messages.json`
(+ `@@extension_id` special case), `getUILanguage`, `acceptLanguages`, `detectLanguage`.

Plan: read `_locales/` from the extension folder at manifest-parse time; `getUILanguage`
from Electron locale; `acceptLanguages` → `[ui, 'en-US']`; `detectLanguage` stub. Many
otherwise-simple extensions break on `getMessage` at startup, so this is cheap and
unblocks a lot.

## Definition of done

Altair runs with its real persisted state (session + local) and localized strings.
