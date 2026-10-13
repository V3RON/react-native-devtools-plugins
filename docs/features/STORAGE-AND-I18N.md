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
- **Write-behind persistence.** A write updates the store and is announced immediately; the
  file is rewritten on a 250 ms per-(extension, area) debounce and on quit (`before-quit` /
  `will-quit`). Rewriting a whole 10 MB area on every write measured ~70 ms of main's event
  loop per tiny `set`, which a frequent writer would turn into a stalled shell; the running
  byte total is kept per area for the same reason. Consequences: a disk error can no longer
  reject the write that caused it (it is logged by main and retried on the next write or
  flush), and a crash or kill loses at most the last 250 ms of `local`/`sync` writes.
- **Key names are plain keys.** `__proto__`, `constructor` and friends are stored, returned and
  reported like any other key.

What remains different from Chrome:

| Area | Status | Note |
| --- | --- | --- |
| `sync` | 🟨 | an alias of local-style storage with sync's limits; there is no Chrome Sync |
| `managed` | ❌ | not present (`chrome.storage.managed` is `undefined`) |
| signature errors | 🟨 | a non-object `set()` etc. rejects / sets `lastError` instead of throwing synchronously |
| `unlimitedStorage` | ❌ | not honored: `local` is always capped at 10 MB |
| `QUOTA_BYTES` accounting | 🟨 | close to Chrome's, not byte-identical (Chrome's per-key overhead is internal) |
| `session` across extension reload/disable | 🟨 | Chrome clears session storage (and resets `setAccessLevel`) when an extension is reloaded or disabled. This shell has no reload/disable path for an extension, so both live for main's lifetime (until the shell quits) |
| dotted keys in old `local`/`sync` files | 🟨 | see "Upgrading" below: readable by name, not rewritten |
| event delivery before the page listens | 🟨 | storage events are pushed immediately (not queued until `DOMContentLoaded` like runtime messages), so a change made before a context has added its listener is not replayed to it — which is also Chrome's behavior for an already-running context |
| frame-less contexts | 🟨 | only frames that registered with the router take part; the content-script app context has no `chrome.storage` |

### Upgrading from the per-frame stores

- **Dotted keys.** The old shim let electron-store treat a dot as a path, so
  `set({"settings.theme": "dark"})` was saved as `{settings: {theme: "dark"}}` and read back by
  path. Which nested objects came from dotted keys cannot be recovered from the file, so no
  automatic migration is attempted (it would have to guess). Instead, the first time an area is
  opened with no `extension-<id>-<area>.meta.json`, a non-empty data file is taken to be the old
  shim's: its content is frozen as a snapshot in the meta file (a new/empty area gets
  `legacy: null`, also written at once). A `get` of a dotted key that is not stored under its own
  name is answered from that snapshot, with limits that keep it from misleading:
  the snapshot is never updated and its top-level key must still hold exactly the snapshot value
  (nested data written after the upgrade is never read as a path); a dotted name that has been
  written or removed since upgrade goes into a persisted *shadow* set and is never resolved
  again (a removed value cannot come back); removing a fallback-resolved key fires
  `onChanged {oldValue}` like any removal. Limits: such keys are not listed by `get(null)` /
  `getKeys`, `getBytesInUse` ignores them, and `remove("settings.theme")` hides the alias but
  leaves the leaf inside the `settings` object (that object is a key of its own). The data file
  holds the extension's keys only; the marker is not stored in the extension's key namespace.
- **`sync` over the new limits.** The old shim never enforced sync's 100 KB / 8 KB-per-item /
  512-item limits, so an existing area can already be over them. The check compares the state
  AFTER the write: a write that leaves the area no larger than it was (replacing a value with a
  smaller one, `remove`, `clear`) is accepted; one that grows it past the limit is rejected with
  `QUOTA_BYTES quota exceeded`. A single value over `QUOTA_BYTES_PER_ITEM` is always rejected.

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
