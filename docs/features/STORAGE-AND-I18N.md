# Storage & i18n (`chrome.storage`, `chrome.i18n`)

| | |
| --- | --- |
| **Status** | ✅ storage real for local/sync/session, one host-owned store per extension with `onChanged` in every context; `managed` and i18n missing |
| **Tier** | 1 |
| **Blocked by** | — |

## `chrome.storage` ✅

Chrome keeps ONE storage per extension, shared by every context of it (devtools page, panel
pages, background worker, options page), and tells every one of them when it changes. So does
this shell, since the state moved out of the frames and into main:

```
 panel frame ──┐                        ┌── STORAGE_DELIVER ──► panel frame      (onChanged)
 worker frame ─┼─ STORAGE_CALL ─► main ─┼── STORAGE_DELIVER ──► worker frame     (onChanged)
 options page ─┘   (area, op, arg)      └── STORAGE_DELIVER ──► options page     (onChanged)
                   src/main/storage-service.js        only frames of the SAME extension
```

| Piece | Where | Role |
| --- | --- | --- |
| Semantics | `src/shared/storage-core.js` | one implementation of get/set/remove/clear/getBytesInUse/getKeys over a `Map`: JSON copies, absent keys omitted, `{oldValue,newValue}` only for keys that really changed, all-or-nothing quota |
| Store + fan-out | `src/main/storage-service.js` | one Map per (extension, area); `local`/`sync` persist, `session` is memory only; applies each write once and broadcasts it |
| Wiring | `src/main/ipc.js` (`STORAGE_CALL`, `STORAGE_DELIVER`) | identity from the registered frame (extension id read from its URL), `storage` permission re-checked from the host's own grants |
| API shape | `src/chrome-shim/storage.js` | promise + callback, `lastError`, per-area and global `onChanged`; a thin client of the above |

Behaviors that match Chrome (all covered by `tests/storage-core.test.js`,
`tests/storage-host.test.js`, and — across real frames and a real worker —
`tests/storage-electron.test.js`):

- **Shared per extension, isolated between extensions.** The extension id comes from the
  calling frame's URL, never from a payload; a delivery goes only to contexts registered under
  that id. Extension B can neither read A's storage nor hear its changes.
- **`onChanged` in every context, the writer's included**, for every area. `chrome.storage.onChanged`
  gets `(changes, areaName)`; `storage.<area>.onChanged` gets `(changes)`. Changes carry
  `oldValue` only for a key that existed and `newValue` only for one that still does; a write
  that changes nothing (identical value, removing an absent key, clearing an empty area) fires
  nothing.
- **Ordering.** Every event carries a per-extension sequence number and every write's reply
  carries the number of the last event it produced. A write's callback/promise is held until
  that event has been delivered to the writing context, so listeners run before the write
  completes (Chrome's order), and all contexts see the same events in the same order whatever
  order IPC replies and pushes happen to arrive in. A lost delivery degrades to "answered after
  2 s", never to a write that never completes.
- **Quota.** `local` and `session`: `QUOTA_BYTES` = 10 485 760; `sync`: 102 400 plus
  `QUOTA_BYTES_PER_ITEM` 8 192 and `MAX_ITEMS` 512 (the write-rate constants are published but
  not enforced). An over-quota write changes nothing and fails with Chrome's text
  (`Session storage quota bytes exceeded. Values were not stored.` / `QUOTA_BYTES quota exceeded`),
  as a rejected promise or as `runtime.lastError` with no value for the callback.
  `getBytesInUse` counts key length + JSON length in UTF-8.
- **`session.setAccessLevel({accessLevel})`**: `TRUSTED_CONTEXTS` (default) or
  `TRUSTED_AND_UNTRUSTED_CONTEXTS`. A context registered as untrusted gets neither reads, writes
  nor events from `session` until an extension page widens it; the level is per extension and
  `setAccessLevel` itself is refused to untrusted contexts. Every frame this shell hosts is a
  trusted extension page and the content-script runner has no `chrome.storage`, so today only
  the unit tests can observe the denial (`attach({trusted: false})`).
- **Lifetime.** `session` lives in main's memory and is gone when the shell quits (Chrome:
  when the browser restarts). `local`/`sync` persist through `electron-store`, in the same
  `extension-<id>-<area>.json` files as before, so earlier data is still read. Main is now the
  only writer, which also ends the old one-store-per-frame race on those files.

What remains different from Chrome:

| Area | Status | Note |
| --- | --- | --- |
| `sync` | 🟨 | an alias of local-style storage with sync's limits; there is no Chrome Sync |
| `managed` | ❌ | not present (`chrome.storage.managed` is `undefined`) |
| signature errors | 🟨 | a non-object `set()` etc. rejects / sets `lastError` instead of throwing synchronously |
| `unlimitedStorage` | ❌ | not honored: `local` is always capped at 10 MB |
| `QUOTA_BYTES` accounting | 🟨 | close to Chrome's, not byte-identical (Chrome's per-key overhead is internal) |
| dotted keys in old `local`/`sync` files | 🟨 | the old per-frame store let electron-store treat `"a.b"` as a path and nested it on disk; main now stores keys verbatim, so such a legacy key reads back as the nested object |
| event delivery before the page listens | 🟨 | storage events are pushed immediately (not queued until `DOMContentLoaded` like runtime messages), so a change made before a context has added its listener is not replayed to it — which is also Chrome's behavior for an already-running context |
| frame-less contexts | 🟨 | only frames that registered with the router take part; the content-script app context has no `chrome.storage` |

### What this changed for Altair

Altair's `assets/tabs.js` stores the app tab id in `chrome.storage.session` from its worker. That
value is now readable from Altair's panel (and vice versa), and a listener in either context
hears the other's write — the silent-empty-area failure the background worker used to expose is
gone. `tabs.create` itself is still inert ([BACKGROUND-WORKER.md](BACKGROUND-WORKER.md)).

Verification: [`docs/evidence/storage-session/`](../evidence/storage-session/README.md) (screenshots
from the real shell: a value written in a panel read by the options page, `onChanged` in the
worker, the devtools page and the options page, and a second extension seeing none of it).

## `chrome.i18n` — missing ❌

Chrome: `getMessage(name, substitutions?)` reading `_locales/<lang>/messages.json`
(+ `@@extension_id` special case), `getUILanguage`, `acceptLanguages`, `detectLanguage`.

Plan: read `_locales/` from the extension folder at manifest-parse time; `getUILanguage`
from Electron locale; `acceptLanguages` → `[ui, 'en-US']`; `detectLanguage` stub. Many
otherwise-simple extensions break on `getMessage` at startup, so this is cheap and
unblocks a lot.

## Definition of done

Altair runs with its real persisted state (session + local) and localized strings.
