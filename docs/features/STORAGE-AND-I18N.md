# Storage & i18n (`chrome.storage`, `chrome.i18n`)

| | |
| --- | --- |
| **Status** | ✅ storage real for local/sync/session, one host-owned store per extension with `onChanged` in every context; `managed` missing; **i18n real** (`getMessage` with Chrome's semantics, synchronous; `detectLanguage` is an honest stub) |
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

## `chrome.i18n` — real ✅ (one honest stub)

`chrome.i18n.getMessage` reads the extension's own `_locales/<locale>/messages.json` with
Chrome's semantics, **synchronously**, from the first statement of the first script. Pure
semantics live in `src/shared/i18n.js`, the host half in `src/main/i18n-host.js`, the frame
half in `src/chrome-shim/i18n.js`.

| API | Status | Notes |
| --- | --- | --- |
| `getMessage(name, substitutions?, options?)` | ✅ | everything below; `escapeLt` honoured; bad calls throw Chrome's signature `TypeError`; more than nine substitutions → `undefined` |
| `getUILanguage()` | ✅ | BCP 47 of the host's UI locale (`pt-BR`) |
| `getAcceptLanguages([cb])` | 🟨 | promise **and** callback. List = UI locale, its bare language, the OS's preferred languages (same expansion), then `en-US, en` if English is not already there. Chrome derives its list from profile language prefs, so e.g. `en-GB` gives `["en-GB","en"]` here vs Chrome's `["en-GB","en-US","en"]` |
| `detectLanguage(text, [cb])` | ❌ honest stub | resolves `{isReliable: false, languages: []}`, a shape Chrome itself returns for text it cannot classify. Chrome ships the CLD3 model; this shell does not, and inventing an answer from a word list would be worse than saying "undetermined" |
| `@@extension_id`, `@@ui_locale`, `@@bidi_dir`, `@@bidi_reversed_dir`, `@@bidi_start_edge`, `@@bidi_end_edge` | ✅ | names case-insensitive; `@@ui_locale` is `pt_BR`-style (not the BCP 47 `pt-BR`); RTL languages: ar, ckb, dv, fa, he, iw, ku, ps, sd, ug, ur, yi |
| `__MSG_name__` in `manifest.json` | ✅ | **only** the fields Chrome localizes: `name`, `short_name`, `description`, `action.default_title` (and MV2 `browser_action`/`page_action`, from Chromium's source, not a run), `commands.*.description`, `omnibox.keyword`. Everything else stays literal — verified in Chromium 141: `permissions`, `host_permissions`, the CSP (Chrome then rejects the marker), `web_accessible_resources`, `background`, `options_ui`, `devtools_page`, `homepage_url`, `author`, `version_name`. That is also a security property: a marker in `host_permissions` must not become `<all_urls>` for one UI language. The panel list's name, `chrome.runtime.getManifest()`, CSP and permission reads all see the localized manifest; `current_locale` is added like Chrome does |
| `__MSG_name__` / `__MSG_@@bidi_dir__` in served `.css` files | ✅ | substituted when the file is served (`src/main/extension-server.js`), as Chrome does; like Chrome, the **first unknown name stops the substitution**, leaving it and every later marker in that file literal |
| `__MSG_…__` in HTML/JS | n/a | Chrome does not substitute there either |

### Message semantics (each rule measured against real Chromium)

Chrome does the work in two stages, and the split is observable, so it is reproduced:

1. **Bundle** (main process; `buildBundle`). The catalogs of the locale chain are merged
   **per message name** — `pt_BR` → `pt` → `default_locale` — so a name missing from `pt_BR`
   comes from `pt`, then from the default. Names are case-insensitive; with `A` and `a` both
   defined the sorted-last key (`a`) wins whatever order the file lists them in. Each
   message's `$placeholder$` (case-insensitive name) is replaced by its `content`, once —
   `content` is not scanned again.
2. **`getMessage`** (frame; `applySubstitutions`). Chromium's `base::ReplaceStringPlaceholders`:
   `$1`…`$9` take the call's substitutions (a missing one is empty, `$10` is `$1` then a
   literal `0`), a run of *k* ≥ 2 dollars becomes *k*−1 dollars (`$$` → `$`), and **any other
   `$x` is dropped together with `x`** (a lone `$`, a trailing `$`, `$0`, `$name`). A single
   string or an array of up to nine is accepted; array members are stringified; a bare
   number/object/`null` means "no substitutions"; unknown names give `""`.

Every claim above is a named case in `tests/i18n.test.js` (labelled "Chromium 141: …").
**Parity is mechanical, not asserted from memory:** `docs/evidence/i18n/chromium-reference/`
loads the fixture cases of `cases.js` into a real headless Chromium 141 (`--load-extension`),
records what it answered (`results.txt`), and `tests/i18n-chromium-parity.test.js` replays the
same cases through this implementation and demands identical output.

### How the data reaches the frame before page scripts run

The constraint: `getMessage` is synchronous and extensions call it at the top of their first
script ("many otherwise-simple extensions break on `getMessage` at startup"), while every IPC
channel here is async by house rule (`src/shared/ipc.js` — no `sendSync`), and an async answer
lands after the first call. Options weighed:

| Option | Verdict |
| --- | --- |
| `ipcRenderer.sendSync` | forbidden by the house rule, and it blocks the renderer on main with no framing |
| `fs` in the preload (`sandbox: false`, so it can) | synchronous and no IPC, but duplicates path containment and locale/placeholder logic in the privileged preload, needs the extensions dir smuggled in via `additionalArguments`, and puts file-reading policy where a page-world bug would be worst |
| async IPC at registration (like the manifest) | too late: the first `getMessage` has already run |
| **synchronous `XMLHttpRequest` to the frame's own `rozenite://<id>/__rozenite_i18n__`** | **chosen** |

The chosen path adds no IPC channel and no new trust: the extension protocol is already the
one sanctioned way for a frame to read its own files. The id is the request's own hostname,
the bundle is built in main (`src/main/i18n-host.js`) under the existing path-containment guard
with the host's UI locale, and the reserved inner path is unreachable as a file (asserted).
The preload reads it lazily on the first i18n call, once, and the shim caches it; an extension
that never touches i18n pays nothing. Measured live: the first statement of a devtools page
and of a background worker both get translated strings (`tests/i18n-electron.test.js`,
`docs/evidence/i18n/`), and the shell records no console issue for it.

Costs, stated plainly: the renderer blocks for one local protocol round trip (a few small
file reads) on the first call; Chromium marks synchronous XHR on a document's main thread as
deprecated, but it is not removed for this scheme and nothing was logged in the runs above;
the bundle is re-read per frame load, so editing a `messages.json` takes effect on the next
reload without restarting the shell.

### UI language

`app.getLocale()` — the locale Chromium resolved for the app (`--lang=pt-BR`, else the OS
language) — and `app.getPreferredSystemLanguages()` for the accept list. `DEVTOOLS_UI_LOCALE`
(e.g. `DEVTOOLS_UI_LOCALE=ar npm start`) overrides it for the extension APIs only, which is
what the tests and the Arabic screenshot use; the frontend itself keeps following Electron's
locale. Without Electron (unit tests) it is `en-US`.

### Known divergences (all pinned by a test)

- **Lenient loading.** Chrome refuses to load an extension whose catalog has an invalid name,
  a message without `message`, a non-string placeholder `content`, an undefined `$variable$`,
  a reserved `@@` key, or a `_locales` folder without `default_locale`. A dev shell that hides
  a panel over a typo in the Portuguese catalog is worse than one that skips the entry, so
  this one skips it (an undefined variable becomes `""`) and logs `[i18n] <id>: …` in main.
  Same for an unknown `__MSG_x__` in the manifest: left as written, not refused.
- **Raw `--lang`.** Chromium reads locale folders from the *raw* language (`fr-CA` →
  `_locales/fr_CA`) while `@@ui_locale` says `fr`; this shell only knows the resolved locale
  (Electron's `app.getLocale()`), so `_locales/fr_CA` is not consulted for fr-CA (it falls to
  `fr`, then the default).
- `getAcceptLanguages` is derived, not read from language preferences (see the table).
- `detectLanguage` never detects.
- JSON with comments: Chrome's extension JSON parser tolerates `//` comments; this one is
  strict `JSON.parse` (a BOM is accepted). `_locales/<dir>` names are matched
  case-insensitively as a convenience Chrome does not offer.
- Catalogs over 8 MB are refused (not a message catalog); CSS over 2 MB is served unlocalized.
- `default_locale` set but no `_locales` folder: Chrome refuses the extension; this shell warns
  and carries on (the bundle then only answers the predefined `@@` messages).
- Marker scan: a name ends at the first `__` (`__MSG_a____MSG_b__` is two markers,
  `__MSG_a__b__` is `a` plus the text `b__`), mirrored from Chromium and pinned by parity cases.

## Definition of done

Altair runs with its real persisted state (session + local) and localized strings. The localized-strings half is covered by the i18n section above and `docs/evidence/i18n/`; the persisted-state half is the storage section's concern.
