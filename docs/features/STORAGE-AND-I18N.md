# Storage & i18n (`chrome.storage`, `chrome.i18n`)

| | |
| --- | --- |
| **Status** | 🟨 storage: see the storage section below; **i18n real** (`getMessage` with Chrome's semantics, synchronous; `detectLanguage` is an honest stub) |
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
